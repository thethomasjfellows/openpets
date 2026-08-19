const smallNumbers = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
] as const;

const tens = ["", "", "twenty", "thirty", "forty", "fifty"] as const;

/** Make numeric clock times pronounceable without changing the visible answer. */
export function normalizeVoiceSpeechText(text: string): string {
  return text.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_match, rawHour: string, rawMinute: string) => {
    const hour = Number(rawHour);
    const minute = Number(rawMinute);
    const spokenHour = numberBelowSixty(hour === 0 ? 12 : hour);
    if (minute === 0) return `${spokenHour} o'clock`;
    if (minute < 10) return `${spokenHour} oh ${numberBelowSixty(minute)}`;
    return `${spokenHour} ${numberBelowSixty(minute)}`;
  });
}

function numberBelowSixty(value: number): string {
  if (value < 20) return smallNumbers[value] ?? String(value);
  const unit = value % 10;
  const base = tens[Math.floor(value / 10)] ?? String(value);
  return unit === 0 ? base : `${base}-${smallNumbers[unit]}`;
}
