/**
 * Regression tests for NaN/Infinity coordinate guards in pet-motion-engine.
 *
 * Bug #72: window.setPosition() was called with NaN coordinates, crashing Electron
 * with `TypeError: Error processing argument at index 0, conversion failure`.
 *
 * Root causes:
 * (a) screen.getDisplayNearestPoint().workArea returns NaN on multi-monitor disconnect
 *     → computeGravityFloor() returns NaN → rawY NaN → setPosition(NaN, NaN, false)
 * (b) window.getPosition() returns NaN mid-destroy/move
 *
 * These tests verify that a non-finite coordinate is never passed to setPosition
 * and that the engine does not throw in either scenario.
 */
import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";

import {
  _sharedTickerActiveForTesting,
  _setScreenForTesting,
  _setIsPetWindowDraggingForTesting,
  _resetMotionStatesForTesting,
  registerPet,
  motionSetPhysics,
  motionSetFollowCursor,
  motionMoveTo,
} from "../src/pet-motion-engine.js";
import { _setScreenForTesting as setDisplayScreen, invalidateDisplayCache, setCrossDisplayRoamingEnabled } from "../src/display.js";

// ---------------------------------------------------------------------------
// Helper: make a mock BrowserWindow with configurable getPosition return value
// ---------------------------------------------------------------------------

function makeWindowMock(posX: number, posY: number, setPositionSpy?: (x: number, y: number) => void) {
  return () => ({
    getPosition: (): [number, number] => [posX, posY],
    isDestroyed: () => false,
    isVisible: () => true,
    setPosition: (x: number, y: number, _animate: boolean) => {
      setPositionSpy?.(x, y);
    },
  } as any);
}

// Normal screen mock used for baseline
const normalScreen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
};

// Screen mock with NaN workArea (simulates monitor disconnect / driver fault)
const nanWorkAreaScreen = {
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getAllDisplays: () => [{ workArea: { x: NaN, y: NaN, width: NaN, height: NaN } }],
  getPrimaryDisplay: () => ({ workArea: { x: NaN, y: NaN, width: NaN, height: NaN } }),
  getDisplayNearestPoint: () => ({ workArea: { x: NaN, y: NaN, width: NaN, height: NaN } }),
};

// Loop interval used by the shared ticker (mirrors production constant)
const loopIntervalMs = 16;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("pet-motion-engine NaN coordinate guards", () => {
  before(() => {
    _setIsPetWindowDraggingForTesting(() => false);
    setCrossDisplayRoamingEnabled(false);
  });

  after(() => {
    _resetMotionStatesForTesting();
    _setScreenForTesting(null);
    setDisplayScreen(null);
    _setIsPetWindowDraggingForTesting(null);
  });

  afterEach(() => {
    _resetMotionStatesForTesting();
  });

  it("tick does NOT call setPosition and does NOT throw when getPosition() returns [NaN, NaN]", async () => {
    // Arrange: normal screen, but window reports NaN position (mid-destroy race)
    _setScreenForTesting(normalScreen as any);
    setDisplayScreen(normalScreen as any);
    invalidateDisplayCache();

    const setPositionCalls: Array<[number, number]> = [];
    const accessor = makeWindowMock(NaN, NaN, (x, y) => setPositionCalls.push([x, y]));

    registerPet("nan-pos-test", accessor);
    motionSetPhysics("nan-pos-test", accessor, { gravity: true, bounce: 0.4 });

    // Let the shared ticker fire several ticks
    await new Promise<void>((resolve) => setTimeout(resolve, loopIntervalMs * 5));

    // No setPosition call should have occurred with non-finite args
    for (const [x, y] of setPositionCalls) {
      assert.ok(
        Number.isFinite(x) && Number.isFinite(y),
        `setPosition called with non-finite coords: (${x}, ${y})`,
      );
    }
    // Additionally, given the [NaN, NaN] guard at top of tickPet, we expect zero calls
    assert.equal(setPositionCalls.length, 0, "setPosition must not be called at all when getPosition returns NaN");
  });

  it("setPosition is never called with non-finite args when workArea has NaN dimensions (monitor disconnect)", async () => {
    // Arrange: workArea returns NaN on all fields — simulates monitor disconnect
    _setScreenForTesting(nanWorkAreaScreen as any);
    setDisplayScreen(nanWorkAreaScreen as any);
    invalidateDisplayCache();

    const setPositionCalls: Array<[number, number]> = [];
    // Window has a valid integer position — only workArea is NaN
    const accessor = makeWindowMock(400, 300, (x, y) => setPositionCalls.push([x, y]));

    registerPet("nan-workarea-test", accessor);
    motionSetPhysics("nan-workarea-test", accessor, { gravity: true, bounce: 0.4 });

    // Let the shared ticker fire several ticks
    await new Promise<void>((resolve) => setTimeout(resolve, loopIntervalMs * 5));

    // Every call that did happen must have finite coordinates
    for (const [x, y] of setPositionCalls) {
      assert.ok(
        Number.isFinite(x) && Number.isFinite(y),
        `setPosition called with non-finite coords: (${x}, ${y})`,
      );
    }
  });

  it("native setPosition conversion failures never escape the shared ticker", async () => {
    _setScreenForTesting(normalScreen as any);
    setDisplayScreen(normalScreen as any);
    invalidateDisplayCache();

    let calls = 0;
    const accessor = () => ({
      getPosition: (): [number, number] => [100, 100],
      isDestroyed: () => false,
      isVisible: () => true,
      setPosition: () => {
        calls += 1;
        throw new TypeError("Error processing argument at index 0, conversion failure");
      },
    } as any);

    registerPet("native-conversion-failure", accessor);
    motionSetPhysics("native-conversion-failure", accessor, { gravity: true, bounce: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, loopIntervalMs * 5));

    assert.equal(calls, 1, "a failed native write unregisters the broken motion state instead of retrying forever");
    assert.equal(_sharedTickerActiveForTesting(), false, "the failed pet cannot leave a crashing timer active");
  });

  it("finite coordinates outside Electron's signed 32-bit boundary are never written", async () => {
    const hugeDisplay = {
      workArea: {
        x: Number.MAX_SAFE_INTEGER - 4_000,
        y: Number.MAX_SAFE_INTEGER - 4_000,
        width: 2_000,
        height: 2_000,
      },
    };
    const hugeCursorScreen = {
      getCursorScreenPoint: () => ({ x: Number.MAX_SAFE_INTEGER, y: Number.MAX_SAFE_INTEGER }),
      getAllDisplays: () => [hugeDisplay],
      getPrimaryDisplay: () => hugeDisplay,
      getDisplayNearestPoint: () => hugeDisplay,
    };
    _setScreenForTesting(hugeCursorScreen as any);
    setDisplayScreen(hugeCursorScreen as any);
    invalidateDisplayCache();

    const setPositionCalls: Array<[number, number]> = [];
    const accessor = makeWindowMock(100, 100, (x, y) => setPositionCalls.push([x, y]));
    registerPet("out-of-range-position", accessor);
    motionSetFollowCursor("out-of-range-position", accessor, { enabled: true, lag: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, loopIntervalMs * 5));

    assert.deepEqual(setPositionCalls, [], "out-of-range coordinates are rejected before Electron conversion");
  });

  it("in-flight motionMoveTo settles (promise resolves) even when getPosition() returns [NaN, NaN]", async () => {
    // Regression for PR #74 review (Bug: NaN early-return stalled the motion loop,
    // leaving moveTarget.elapsed frozen so the motionMoveTo promise never resolved).
    _setScreenForTesting(normalScreen as any);
    setDisplayScreen(normalScreen as any);
    invalidateDisplayCache();

    const setPositionCalls: Array<[number, number]> = [];
    const accessor = makeWindowMock(NaN, NaN, (x, y) => setPositionCalls.push([x, y]));

    registerPet("nan-move-test", accessor);
    motionSetPhysics("nan-move-test", accessor, { gravity: true, bounce: 0.4 });

    const movePromise = motionMoveTo("nan-move-test", accessor, { x: 500, y: 500 }, { durationMs: 100 });

    const outcome = await Promise.race([
      movePromise.then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    assert.equal(
      outcome,
      "resolved",
      "motionMoveTo promise must resolve (loop must advance elapsed) even under NaN getPosition",
    );

    // And the NaN path must never have written a non-finite position
    for (const [x, y] of setPositionCalls) {
      assert.ok(
        Number.isFinite(x) && Number.isFinite(y),
        `setPosition called with non-finite coords: (${x}, ${y})`,
      );
    }
  });

  it("delegated motionMoveTo completes after its continuous motion mode is disabled", async () => {
    // Contract: once a move is accepted by the shared ticker, turning off the
    // physics mode that delegated it must not abandon the move or its promise.
    _setScreenForTesting(normalScreen as any);
    setDisplayScreen(normalScreen as any);
    invalidateDisplayCache();

    const setPositionCalls: Array<[number, number]> = [];
    const accessor = makeWindowMock(100, 100, (x, y) => setPositionCalls.push([x, y]));

    registerPet("delegated-move-test", accessor);
    motionSetPhysics("delegated-move-test", accessor, { gravity: true, bounce: 0.4 });

    const movePromise = motionMoveTo(
      "delegated-move-test",
      accessor,
      { x: 500, y: 500 },
      { durationMs: 100, easing: "linear" },
    );
    motionSetPhysics("delegated-move-test", accessor, { gravity: false });

    assert.equal(_sharedTickerActiveForTesting(), true, "the delegated move keeps the shared ticker active");

    const outcome = await Promise.race([
      movePromise.then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    assert.equal(outcome, "resolved", "disabling physics must not strand the delegated move");
    assert.deepEqual(setPositionCalls.at(-1), [500, 500], "the accepted move still reaches its target");

    await new Promise<void>((resolve) => setTimeout(resolve, loopIntervalMs * 2));
    assert.equal(_sharedTickerActiveForTesting(), false, "the ticker stops once the delegated move completes");
  });

  it("delegated motionMoveTo recovers when only its initial position read is NaN", async () => {
    // Contract: a transient native-position failure at acceptance must not poison
    // later interpolation after finite coordinates become available.
    _setScreenForTesting(normalScreen as any);
    setDisplayScreen(normalScreen as any);
    invalidateDisplayCache();

    let positionReads = 0;
    let position: [number, number] = [100, 100];
    const setPositionCalls: Array<[number, number]> = [];
    const accessor = () => ({
      getPosition: (): [number, number] => positionReads++ === 0 ? [NaN, NaN] : position,
      isDestroyed: () => false,
      isVisible: () => true,
      setPosition: (x: number, y: number) => {
        position = [x, y];
        setPositionCalls.push([x, y]);
      },
    } as any);

    registerPet("transient-nan-move-test", accessor);
    motionSetPhysics("transient-nan-move-test", accessor, { gravity: true, bounce: 0.4 });
    const movePromise = motionMoveTo("transient-nan-move-test", accessor, { x: 500, y: 500 }, { durationMs: 100 });
    motionSetPhysics("transient-nan-move-test", accessor, { gravity: false });

    const outcome = await Promise.race([
      movePromise.then(() => "resolved" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);

    assert.equal(outcome, "resolved");
    assert.deepEqual(setPositionCalls.at(-1), [500, 500]);
    assert.ok(setPositionCalls.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  });
});
