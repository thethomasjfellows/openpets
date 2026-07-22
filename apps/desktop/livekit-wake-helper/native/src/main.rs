use std::collections::VecDeque;
use std::env;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};
use std::thread;

use base64::Engine as _;
use livekit_wakeword::WakeWordModel;
use serde::Deserialize;
use serde_json::json;

const PROTOCOL_VERSION: u8 = 2;
const SAMPLE_RATE: usize = 16_000;
const WINDOW_SAMPLES: usize = SAMPLE_RATE * 2;
const INFERENCE_STRIDE_SAMPLES: usize = SAMPLE_RATE / 10;
const MAX_FRAME_SAMPLES: usize = SAMPLE_RATE;
const AUDIO_QUEUE_CAPACITY: usize = 128;
const OFFICIAL_PHRASE: &str = "Hey Pedra";

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Command {
    Configure {
        version: u8,
        phrase: String,
    },
    Pcm {
        version: u8,
        #[serde(rename = "sampleRate")]
        sample_rate: u32,
        channels: u8,
        format: String,
        #[serde(rename = "samplesBase64")]
        samples_base64: String,
        #[serde(rename = "capturedAt")]
        captured_at: f64,
    },
    Reset {
        version: u8,
    },
    Stop {
        version: u8,
    },
}

struct Detector {
    model: WakeWordModel,
    model_name: String,
    threshold: f32,
    samples: VecDeque<i16>,
    samples_since_inference: usize,
    latest_captured_at: Option<f64>,
    armed: bool,
}

impl Detector {
    fn new(classifier: PathBuf, threshold: f32) -> Result<Self, String> {
        let model_name = classifier
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("hey_pedra")
            .to_owned();
        let model = WakeWordModel::new(&[classifier], SAMPLE_RATE as u32)
            .map_err(|error| format!("classifier-load-failed: {error}"))?;
        Ok(Self {
            model,
            model_name,
            threshold,
            samples: VecDeque::with_capacity(WINDOW_SAMPLES),
            samples_since_inference: 0,
            latest_captured_at: None,
            armed: false,
        })
    }

    fn configure(&mut self, phrase: &str) -> Result<(), String> {
        if phrase.trim().to_lowercase() != OFFICIAL_PHRASE.to_lowercase() {
            return Err("phrase-not-supported".to_owned());
        }
        self.reset();
        self.armed = true;
        Ok(())
    }

    fn reset(&mut self) {
        self.samples.clear();
        self.samples_since_inference = 0;
        self.latest_captured_at = None;
    }

    fn ingest(&mut self, bytes: &[u8], captured_at: f64) -> Result<(), String> {
        if !self.armed
            || bytes.is_empty()
            || bytes.len() % 4 != 0
            || bytes.len() / 4 > MAX_FRAME_SAMPLES
        {
            return Err("invalid-pcm-frame".to_owned());
        }
        if !captured_at.is_finite() || captured_at < 0.0 {
            return Err("invalid-capture-time".to_owned());
        }
        for chunk in bytes.chunks_exact(4) {
            let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if !sample.is_finite() || !(-1.0..=1.0).contains(&sample) {
                return Err("invalid-pcm-sample".to_owned());
            }
            if self.samples.len() == WINDOW_SAMPLES {
                self.samples.pop_front();
            }
            self.samples
                .push_back((sample * i16::MAX as f32).round() as i16);
            self.samples_since_inference += 1;
        }
        self.latest_captured_at = Some(captured_at);
        Ok(())
    }

    fn predict_if_due(&mut self) -> Result<Option<(f32, f64)>, String> {
        if self.samples.len() < WINDOW_SAMPLES
            || self.samples_since_inference < INFERENCE_STRIDE_SAMPLES
        {
            return Ok(None);
        }
        self.samples_since_inference = 0;
        let window: Vec<i16> = self.samples.iter().copied().collect();
        let scores = self
            .model
            .predict(&window)
            .map_err(|error| format!("inference-failed: {error}"))?;
        let score = scores
            .get(&self.model_name)
            .copied()
            .unwrap_or(0.0)
            .clamp(0.0, 1.0);
        if score >= self.threshold {
            let captured_at = self.latest_captured_at.unwrap_or_default();
            self.reset();
            Ok(Some((score, captured_at)))
        } else {
            Ok(None)
        }
    }
}

enum WorkerCommand {
    Configure {
        phrase: String,
        reply: mpsc::Sender<Result<(), String>>,
    },
    Pcm {
        bytes: Vec<u8>,
        captured_at: f64,
    },
    Reset,
    Stop,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WorkerAction {
    Continue,
    Predict,
    Stop,
}

fn main() {
    if let Err(message) = run() {
        emit(json!({ "version": PROTOCOL_VERSION, "type": "error", "message": message }));
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let (classifier, threshold) = parse_args()?;
    let detector = Detector::new(classifier, threshold)?;
    let (worker_tx, worker_rx) = mpsc::sync_channel(AUDIO_QUEUE_CAPACITY);
    let worker = thread::Builder::new()
        .name("openpets-wake-inference".to_owned())
        .spawn(move || run_worker(detector, worker_rx))
        .map_err(|error| format!("worker-start-failed: {error}"))?;
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("stdin-failed: {error}"))?;
        if line.len() > 2_000_000 {
            return Err("command-too-large".to_owned());
        }
        let command: Command =
            serde_json::from_str(&line).map_err(|_| "invalid-command".to_owned())?;
        let version = match &command {
            Command::Configure { version, .. }
            | Command::Pcm { version, .. }
            | Command::Reset { version }
            | Command::Stop { version } => *version,
        };
        if version != PROTOCOL_VERSION {
            return Err("unsupported-protocol".to_owned());
        }
        match command {
            Command::Configure { phrase, .. } => {
                let (reply_tx, reply_rx) = mpsc::channel();
                send_worker(
                    &worker_tx,
                    WorkerCommand::Configure {
                        phrase,
                        reply: reply_tx,
                    },
                )?;
                match reply_rx
                    .recv()
                    .map_err(|_| "helper-worker-stopped".to_owned())?
                {
                    Ok(()) => emit(json!({ "version": PROTOCOL_VERSION, "type": "ready" })),
                    Err(code) => {
                        emit(
                            json!({ "version": PROTOCOL_VERSION, "type": "error", "code": code, "message": "This classifier only supports Hey Pedra." }),
                        );
                        send_worker(&worker_tx, WorkerCommand::Stop)?;
                        let _ = worker.join();
                        return Ok(());
                    }
                }
            }
            Command::Pcm {
                sample_rate,
                channels,
                format,
                samples_base64,
                captured_at,
                ..
            } => {
                if sample_rate != SAMPLE_RATE as u32 || channels != 1 || format != "f32le" {
                    return Err("unsupported-audio-format".to_owned());
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(samples_base64)
                    .map_err(|_| "invalid-pcm-base64".to_owned())?;
                send_worker(&worker_tx, WorkerCommand::Pcm { bytes, captured_at })?;
            }
            Command::Reset { .. } => send_worker(&worker_tx, WorkerCommand::Reset)?,
            Command::Stop { .. } => {
                send_worker(&worker_tx, WorkerCommand::Stop)?;
                return worker
                    .join()
                    .map_err(|_| "helper-worker-panicked".to_owned())?;
            }
        }
    }
    let _ = worker_tx.send(WorkerCommand::Stop);
    worker
        .join()
        .map_err(|_| "helper-worker-panicked".to_owned())?
}

fn send_worker(sender: &SyncSender<WorkerCommand>, command: WorkerCommand) -> Result<(), String> {
    sender
        .send(command)
        .map_err(|_| "helper-worker-stopped".to_owned())
}

fn run_worker(mut detector: Detector, receiver: Receiver<WorkerCommand>) -> Result<(), String> {
    loop {
        let command = receiver
            .recv()
            .map_err(|_| "helper-input-closed".to_owned())?;
        let action = handle_worker_command(&mut detector, command)?;
        if action == WorkerAction::Stop {
            return Ok(());
        }
        if action != WorkerAction::Predict {
            continue;
        }

        // Inference is intentionally kept off the stdin reader. Before each
        // prediction, consume every frame that arrived while the previous
        // prediction was running so the model sees the newest audio window
        // instead of working through an ever-growing realtime backlog.
        loop {
            match receiver.try_recv() {
                Ok(command) => {
                    if handle_worker_command(&mut detector, command)? == WorkerAction::Stop {
                        return Ok(());
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Ok(()),
            }
        }

        if let Some((score, captured_at)) = detector.predict_if_due()? {
            emit(json!({
                "version": PROTOCOL_VERSION,
                "type": "keyword",
                "score": score,
                "capturedAt": captured_at,
                "windowMs": WINDOW_SAMPLES * 1_000 / SAMPLE_RATE,
                "strideMs": INFERENCE_STRIDE_SAMPLES * 1_000 / SAMPLE_RATE,
            }));
        }
    }
}

fn handle_worker_command(
    detector: &mut Detector,
    command: WorkerCommand,
) -> Result<WorkerAction, String> {
    match command {
        WorkerCommand::Configure { phrase, reply } => {
            let result = detector.configure(&phrase);
            let _ = reply.send(result);
            Ok(WorkerAction::Continue)
        }
        WorkerCommand::Pcm { bytes, captured_at } => {
            detector.ingest(&bytes, captured_at)?;
            Ok(WorkerAction::Predict)
        }
        WorkerCommand::Reset => {
            detector.reset();
            Ok(WorkerAction::Continue)
        }
        WorkerCommand::Stop => Ok(WorkerAction::Stop),
    }
}

fn parse_args() -> Result<(PathBuf, f32), String> {
    let mut args = env::args().skip(1);
    let mut classifier = None;
    let mut threshold = 0.68_f32;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--classifier" => classifier = args.next().map(PathBuf::from),
            "--threshold" => {
                threshold = args
                    .next()
                    .ok_or_else(|| "missing-threshold".to_owned())?
                    .parse::<f32>()
                    .map_err(|_| "invalid-threshold".to_owned())?;
            }
            _ => return Err("unsupported-argument".to_owned()),
        }
    }
    if !(0.0..=1.0).contains(&threshold) {
        return Err("invalid-threshold".to_owned());
    }
    Ok((
        classifier.ok_or_else(|| "missing-classifier".to_owned())?,
        threshold,
    ))
}

fn emit(value: serde_json::Value) {
    let mut stdout = io::stdout().lock();
    let _ = writeln!(stdout, "{value}");
    let _ = stdout.flush();
}
