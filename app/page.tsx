"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import * as THREE from "three";

type OrientationSample = {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  absolute: boolean | null;
};

type MotionSample = {
  orientation: OrientationSample | null;
  rotationRate: {
    alpha: number | null;
    beta: number | null;
    gamma: number | null;
  } | null;
  acceleration: {
    x: number | null;
    y: number | null;
    z: number | null;
  } | null;
  accelerationIncludingGravity: {
    x: number | null;
    y: number | null;
    z: number | null;
  } | null;
  interval: number | null;
};

type StoreEntry = {
  t: number;
  seq: number;
  sample: MotionSample | null;
};

type PermissionState = "unknown" | "granted" | "denied";
type ScoreOwner = "player" | "cpu";
type HostPhase = "calibration" | "game";

type SwingPacket = {
  strength: number;
  roll: number;
  pitch: number;
  at: number;
};

type SwingAxis = "alpha" | "beta" | "gamma";

type ControlState = {
  roll: number;
  pitch: number;
  yaw: number;
  swingMeter: number;
  pendingSwing: SwingPacket | null;
  lastSwingAt: number;
  lastSeq: number;
  neutralReady: boolean;
  neutralRoll: number;
  neutralPitch: number;
  neutralYaw: number;
  racketRoll: number;
  racketPitch: number;
  racketYaw: number;
  lastAccelMag: number;
  swingPrimed: boolean;
  swingPrimeAxis: SwingAxis | null;
  swingPrimeSign: number;
  swingPrimedAt: number;
  swingForwardRate: number;
  swingSideRate: number;
  swingLiftRate: number;
};

type AvatarSim = {
  x: number;
  targetX: number;
  swingT: number;
  power: number;
  roll: number;
  pitch: number;
  used: boolean;
  cooldown: number;
  flash: number;
};

type MatchState = {
  playerScore: number;
  cpuScore: number;
  rally: number;
  winner: ScoreOwner | null;
  server: ScoreOwner;
  serveTimer: number;
  lastHitter: ScoreOwner | null;
  expectedBounce: ScoreOwner | null;
  bounced: boolean;
  serveInFlight: boolean;
  status: string;
};

type SimState = {
  ballPos: THREE.Vector3;
  ballVel: THREE.Vector3;
  ballSpinSide: number;
  ballSpinTop: number;
  player: AvatarSim;
  cpu: AvatarSim;
  match: MatchState;
};

type PermissionRequestCapable = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type AvatarVisual = {
  group: THREE.Group;
  swingPivot: THREE.Object3D;
  bodyMaterial: THREE.MeshStandardMaterial;
  racketMaterial: THREE.MeshStandardMaterial;
};

type PovRacketVisual = {
  group: THREE.Group;
  pivot: THREE.Object3D;
  frameMaterial: THREE.MeshStandardMaterial;
};

const COURT_HALF_WIDTH = 4.1;
const COURT_HALF_LENGTH = 11.9;
const BASELINE_PLAYER_Z = 9.6;
const BASELINE_CPU_Z = -9.6;
const SERVICE_LINE_Z = 6.4;
const NET_Z = 0;
const NET_HEIGHT = 1.0;

const BALL_RADIUS = 0.14;
const GRAVITY = 9.8;
const GROUND_BOUNCE = 0.72;
const AIR_DRAG = 0.014;

const PLAYER_SPEED = 8.3;
const CPU_SPEED = 7.4;
const RACKET_REACH_X = 1.05;
const HIT_Y_MIN = 0.35;
const HIT_Y_MAX = 2.8;

const SWING_DURATION = 0.32;
const SWING_COOLDOWN = 0.16;
const SWING_TRIGGER = 0.5;
const SWING_REARM_MS = 250;
const SWING_PRIME_RATE = 82;
const SWING_RELEASE_RATE = 128;
const SWING_PRIME_TIMEOUT_MS = 850;
const ROLL_RANGE_DEG = 34;
const PITCH_RANGE_DEG = 46;
const YAW_RANGE_DEG = 60;
const ORIENTATION_SMOOTHING = 0.34;

const CONNECTION_TIMEOUT_MS = 1200;
const POINTS_TO_WIN = 7;

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function makeSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function blankSample(): MotionSample {
  return {
    orientation: null,
    rotationRate: null,
    acceleration: null,
    accelerationIncludingGravity: null,
    interval: null,
  };
}

function getRawRoll(sample: MotionSample | null): number | null {
  const gamma = sample?.orientation?.gamma;
  return typeof gamma === "number" && Number.isFinite(gamma) ? gamma : null;
}

function getRawPitch(sample: MotionSample | null): number | null {
  const beta = sample?.orientation?.beta;
  return typeof beta === "number" && Number.isFinite(beta) ? beta : null;
}

function getRawYaw(sample: MotionSample | null): number | null {
  const alpha = sample?.orientation?.alpha;
  return typeof alpha === "number" && Number.isFinite(alpha) ? alpha : null;
}

function shortestAngleDelta(fromDeg: number, toDeg: number) {
  let delta = fromDeg - toDeg;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function analyzeSwing(sample: MotionSample | null, previousAccelMagnitude = 9.8): {
  strength: number;
  accelMagnitude: number;
  accelBurst: number;
  rotationBurst: number;
  primaryAxis: SwingAxis;
  primaryRate: number;
  sideRate: number;
  liftRate: number;
} {
  const rate = sample?.rotationRate;
  const gravity = sample?.accelerationIncludingGravity;

  const alpha = typeof rate?.alpha === "number" && Number.isFinite(rate.alpha) ? rate.alpha : 0;
  const beta = typeof rate?.beta === "number" && Number.isFinite(rate.beta) ? rate.beta : 0;
  const gamma = typeof rate?.gamma === "number" && Number.isFinite(rate.gamma) ? rate.gamma : 0;
  const gyroMagnitude = Math.sqrt(alpha ** 2 + beta ** 2 + gamma ** 2);
  const rotationBurst = clamp((gyroMagnitude - 30) / 250, 0, 1);

  const axes: Array<{ axis: SwingAxis; value: number }> = [
    { axis: "alpha", value: alpha },
    { axis: "beta", value: beta },
    { axis: "gamma", value: gamma },
  ];
  axes.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const primaryAxis = axes[0]?.axis ?? "beta";
  const primaryRate = axes[0]?.value ?? 0;

  const gx = typeof gravity?.x === "number" && Number.isFinite(gravity.x) ? gravity.x : 0;
  const gy = typeof gravity?.y === "number" && Number.isFinite(gravity.y) ? gravity.y : 0;
  const gz = typeof gravity?.z === "number" && Number.isFinite(gravity.z) ? gravity.z : 0;
  const gravityMagnitude = Math.sqrt(gx ** 2 + gy ** 2 + gz ** 2);
  const jerk = Math.abs(gravityMagnitude - previousAccelMagnitude);
  const accelBurst = clamp((jerk - 0.55) / 4.9, 0, 1);

  return {
    strength: clamp(rotationBurst * 0.72 + accelBurst * 0.46, 0, 1),
    accelMagnitude: gravityMagnitude,
    accelBurst,
    rotationBurst,
    primaryAxis,
    primaryRate,
    sideRate: gamma,
    liftRate: -beta,
  };
}

function updateControlFromSample(control: ControlState, sample: MotionSample | null, sampleTime: number) {
  const rawRoll = getRawRoll(sample);
  const rawPitch = getRawPitch(sample);
  const rawYaw = getRawYaw(sample);

  if (
    rawRoll !== null &&
    rawPitch !== null &&
    (Number.isNaN(rawRoll) || Number.isNaN(rawPitch) || !Number.isFinite(rawRoll) || !Number.isFinite(rawPitch))
  ) {
    return;
  }

  if (!control.neutralReady && rawRoll !== null && rawPitch !== null) {
    control.neutralReady = true;
    control.neutralRoll = rawRoll;
    control.neutralPitch = rawPitch;
    control.neutralYaw = rawYaw ?? 0;
  }

  if (control.neutralReady && rawRoll !== null && rawPitch !== null) {
    const normalizedRoll = clamp((rawRoll - control.neutralRoll) / ROLL_RANGE_DEG, -1, 1);
    const normalizedPitch = clamp((rawPitch - control.neutralPitch) / PITCH_RANGE_DEG, -1, 1);
    const rawYawDelta = rawYaw == null ? 0 : shortestAngleDelta(rawYaw, control.neutralYaw);
    const normalizedYaw = clamp(rawYawDelta / YAW_RANGE_DEG, -1, 1);
    control.roll = THREE.MathUtils.lerp(control.roll, normalizedRoll, ORIENTATION_SMOOTHING);
    control.pitch = THREE.MathUtils.lerp(control.pitch, normalizedPitch, ORIENTATION_SMOOTHING);
    control.yaw = THREE.MathUtils.lerp(control.yaw, normalizedYaw, ORIENTATION_SMOOTHING);

    control.racketRoll = THREE.MathUtils.degToRad(clamp(rawRoll - control.neutralRoll, -120, 120));
    control.racketPitch = THREE.MathUtils.degToRad(clamp(rawPitch - control.neutralPitch, -130, 130));
    control.racketYaw = THREE.MathUtils.degToRad(clamp(rawYawDelta, -140, 140));
  }

  const swing = analyzeSwing(sample, control.lastAccelMag);
  control.lastAccelMag = THREE.MathUtils.lerp(control.lastAccelMag, swing.accelMagnitude, 0.35);
  control.swingForwardRate = THREE.MathUtils.lerp(control.swingForwardRate, Math.abs(swing.primaryRate), 0.18);
  control.swingSideRate = THREE.MathUtils.lerp(control.swingSideRate, swing.sideRate, 0.24);
  control.swingLiftRate = THREE.MathUtils.lerp(control.swingLiftRate, swing.liftRate, 0.24);

  if (control.swingPrimed && sampleTime - control.swingPrimedAt > SWING_PRIME_TIMEOUT_MS) {
    control.swingPrimed = false;
    control.swingPrimeAxis = null;
    control.swingPrimeSign = 0;
  }

  const primaryAbs = Math.abs(swing.primaryRate);
  const primarySign = Math.sign(swing.primaryRate || 0);

  if (!control.swingPrimed) {
    const directFlick =
      primaryAbs > SWING_RELEASE_RATE * 1.18 &&
      swing.rotationBurst > 0.74 &&
      swing.accelBurst > 0.42;
    if (directFlick) {
      control.swingMeter = Math.max(control.swingMeter * 0.42, swing.strength * 0.95);
      control.swingForwardRate = primaryAbs;
      control.swingSideRate = swing.sideRate;
      control.swingLiftRate = swing.liftRate;
      return;
    }

    if (primaryAbs > SWING_PRIME_RATE) {
      control.swingPrimed = true;
      control.swingPrimeAxis = swing.primaryAxis;
      control.swingPrimeSign = primarySign === 0 ? 1 : primarySign;
      control.swingPrimedAt = sampleTime;
    }
    control.swingMeter = Math.max(control.swingMeter * 0.8, swing.strength * 0.42);
    return;
  }

  const sameAxis = swing.primaryAxis === control.swingPrimeAxis;
  const reversed = primarySign !== 0 && primarySign === -control.swingPrimeSign;
  const releaseReady =
    primaryAbs > SWING_RELEASE_RATE &&
    (sameAxis || swing.accelBurst > 0.58) &&
    (reversed || swing.accelBurst > 0.66);

  if (releaseReady) {
    const rateBonus = clamp((primaryAbs - SWING_RELEASE_RATE) / 220, 0, 0.34);
    const releaseStrength = clamp(
      swing.rotationBurst * 0.68 + swing.accelBurst * 0.36 + rateBonus,
      0,
      1,
    );
    control.swingMeter = Math.max(control.swingMeter * 0.35, releaseStrength);
    control.swingForwardRate = primaryAbs;
    control.swingSideRate = swing.sideRate;
    control.swingLiftRate = swing.liftRate;
    control.swingPrimed = false;
    control.swingPrimeAxis = null;
    control.swingPrimeSign = 0;
    return;
  }

  control.swingMeter = Math.max(control.swingMeter * 0.86, swing.strength * 0.55);
}

function opponent(owner: ScoreOwner): ScoreOwner {
  return owner === "player" ? "cpu" : "player";
}

function createAvatarState(): AvatarSim {
  return {
    x: 0,
    targetX: 0,
    swingT: 0,
    power: 0,
    roll: 0,
    pitch: 0,
    used: false,
    cooldown: 0,
    flash: 0,
  };
}

function placeServeBall(sim: SimState, server: ScoreOwner) {
  const serverAvatar = server === "player" ? sim.player : sim.cpu;
  sim.ballPos.x = clamp(serverAvatar.x + (server === "player" ? 0.24 : -0.24), -COURT_HALF_WIDTH * 0.9, COURT_HALF_WIDTH * 0.9);
  sim.ballPos.z = server === "player" ? BASELINE_PLAYER_Z : BASELINE_CPU_Z;
  sim.ballPos.y = 1.45;
  sim.ballVel.set(0, 0, 0);
  sim.ballSpinSide = 0;
  sim.ballSpinTop = 0;
}

function createSimState(): SimState {
  const sim: SimState = {
    ballPos: new THREE.Vector3(0, 1.45, BASELINE_PLAYER_Z),
    ballVel: new THREE.Vector3(0, 0, 0),
    ballSpinSide: 0,
    ballSpinTop: 0,
    player: createAvatarState(),
    cpu: createAvatarState(),
    match: {
      playerScore: 0,
      cpuScore: 0,
      rally: 0,
      winner: null,
      server: "player",
      serveTimer: 0.95,
      lastHitter: null,
      expectedBounce: null,
      bounced: false,
      serveInFlight: false,
      status: "Swing your phone to serve",
    },
  };

  placeServeBall(sim, "player");
  return sim;
}

function startSwing(avatar: AvatarSim, strength: number, roll: number, pitch: number) {
  avatar.swingT = SWING_DURATION;
  avatar.power = clamp(strength, 0.2, 1);
  avatar.roll = clamp(roll, -1, 1);
  avatar.pitch = clamp(pitch, -1, 1);
  avatar.used = false;
  avatar.cooldown = SWING_COOLDOWN;
}

function strikeBall(
  sim: SimState,
  hitter: ScoreOwner,
  power: number,
  roll: number,
  pitch: number,
  isServe: boolean,
) {
  const forward = (isServe ? 10.8 : 12.2) + power * (isServe ? 3.6 : 4.4);
  const toward = hitter === "player" ? -1 : 1;
  const lateral = clamp(
    roll * 4.8 + (hitter === "cpu" ? (Math.random() - 0.5) * 1.3 : 0),
    -7.8,
    7.8,
  );
  const lift =
    (isServe ? 4.2 : 3.6) +
    power * (isServe ? 1.55 : 1.35) +
    clamp(-pitch * 1.15, -0.9, 1.2);

  sim.ballVel.set(lateral, lift, toward * forward);
  sim.ballSpinSide = roll * (2.6 + power * 3.2);
  sim.ballSpinTop = clamp(-pitch * 3.4 + power * 1.4, -5.2, 6.2);

  if (isServe) {
    if (hitter === "player") {
      sim.ballPos.z = BASELINE_PLAYER_Z - 0.3;
      sim.ballPos.x = clamp(sim.player.x + roll * 0.18, -COURT_HALF_WIDTH + 0.3, COURT_HALF_WIDTH - 0.3);
    } else {
      sim.ballPos.z = BASELINE_CPU_Z + 0.3;
      sim.ballPos.x = clamp(sim.cpu.x - roll * 0.18, -COURT_HALF_WIDTH + 0.3, COURT_HALF_WIDTH - 0.3);
    }
  }

  sim.match.lastHitter = hitter;
  sim.match.expectedBounce = opponent(hitter);
  sim.match.bounced = false;
  sim.match.serveInFlight = isServe;
  sim.match.rally = Math.max(1, sim.match.rally + 1);
}

function canPlayerHit(sim: SimState) {
  const ball = sim.ballPos;
  return (
    sim.ballVel.z > 0 &&
    ball.z > 4.4 &&
    ball.z < COURT_HALF_LENGTH + 0.8 &&
    Math.abs(ball.x - sim.player.x) <= RACKET_REACH_X &&
    ball.y >= HIT_Y_MIN &&
    ball.y <= HIT_Y_MAX
  );
}

function canCpuHit(sim: SimState) {
  const ball = sim.ballPos;
  return (
    sim.ballVel.z < 0 &&
    ball.z < -4.4 &&
    ball.z > -COURT_HALF_LENGTH - 0.8 &&
    Math.abs(ball.x - sim.cpu.x) <= RACKET_REACH_X &&
    ball.y >= HIT_Y_MIN &&
    ball.y <= HIT_Y_MAX
  );
}

function approach(current: number, target: number, maxDelta: number) {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

function createAvatarVisual(side: ScoreOwner): AvatarVisual {
  const group = new THREE.Group();
  const bodyColor = side === "player" ? 0x10b981 : 0xf97316;

  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: bodyColor,
    roughness: 0.35,
    metalness: 0.08,
  });
  const headMaterial = new THREE.MeshStandardMaterial({
    color: 0xfde68a,
    roughness: 0.5,
    metalness: 0.03,
  });
  const shortsMaterial = new THREE.MeshStandardMaterial({
    color: 0x111827,
    roughness: 0.6,
    metalness: 0.02,
  });
  const handleMaterial = new THREE.MeshStandardMaterial({
    color: 0xbfc8d6,
    roughness: 0.3,
    metalness: 0.35,
  });
  const racketMaterial = new THREE.MeshStandardMaterial({
    color: 0x93c5fd,
    roughness: 0.3,
    metalness: 0.25,
  });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 8, 12), bodyMaterial);
  torso.position.y = 1.05;
  group.add(torso);

  const shorts = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.26, 0.36), shortsMaterial);
  shorts.position.y = 0.44;
  group.add(shorts);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 20, 20), headMaterial);
  head.position.y = 1.88;
  group.add(head);

  const swingPivot = new THREE.Object3D();
  swingPivot.position.set(side === "player" ? 0.42 : -0.42, 1.38, 0.04);

  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.62, 10), handleMaterial);
  handle.rotation.z = side === "player" ? -0.55 : 0.55;
  handle.position.set(0, -0.3, 0);
  swingPivot.add(handle);

  const racketHead = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.035, 14, 30), racketMaterial);
  racketHead.rotation.x = Math.PI / 2;
  racketHead.position.set(side === "player" ? 0.25 : -0.25, -0.58, 0);
  swingPivot.add(racketHead);

  group.add(swingPivot);

  return {
    group,
    swingPivot,
    bodyMaterial,
    racketMaterial,
  };
}

function createPovRacketVisual(): PovRacketVisual {
  const group = new THREE.Group();
  const pivot = new THREE.Object3D();
  pivot.position.set(0.36, -0.22, -0.88);

  const gripMaterial = new THREE.MeshStandardMaterial({
    color: 0xe2e8f0,
    roughness: 0.34,
    metalness: 0.22,
  });
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x93c5fd,
    roughness: 0.26,
    metalness: 0.18,
  });
  const stringMaterial = new THREE.MeshStandardMaterial({
    color: 0xdbeafe,
    roughness: 0.55,
    metalness: 0.05,
  });

  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.033, 0.56, 12), gripMaterial);
  handle.rotation.z = -0.76;
  handle.position.set(-0.02, -0.16, 0.02);
  pivot.add(handle);

  const throat = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 10), frameMaterial);
  throat.rotation.z = -0.76;
  throat.position.set(0.1, -0.26, -0.02);
  pivot.add(throat);

  const frame = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.03, 14, 32), frameMaterial);
  frame.rotation.x = Math.PI / 2;
  frame.position.set(0.22, -0.42, -0.08);
  pivot.add(frame);

  const strings = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.205, 24), stringMaterial);
  strings.rotation.x = Math.PI / 2;
  strings.position.set(0.22, -0.42, -0.08);
  pivot.add(strings);

  group.add(pivot);

  return {
    group,
    pivot,
    frameMaterial,
  };
}

export default function Home() {
  const [role, setRole] = useState<"host" | "phone">("host");
  const [session, setSession] = useState("");
  const [phoneUrl, setPhoneUrl] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [latest, setLatest] = useState<StoreEntry | null>(null);
  const [permission, setPermission] = useState<PermissionState>("unknown");
  const [sensorAvailable, setSensorAvailable] = useState(true);
  const [clock, setClock] = useState(() => Date.now());
  const [phoneTelemetry, setPhoneTelemetry] = useState({
    roll: 0,
    pitch: 0,
    swing: 0,
    packets: 0,
  });
  const [gameHud, setGameHud] = useState({
    player: 0,
    cpu: 0,
    rally: 0,
    winner: null as ScoreOwner | null,
    status: "Swing your phone to serve",
  });
  const [controlHud, setControlHud] = useState({ roll: 0, pitch: 0, swing: 0 });
  const [hostPhase, setHostPhase] = useState<HostPhase>("calibration");
  const [neutralReady, setNeutralReady] = useState(false);

  const latestRef = useRef<MotionSample | null>(null);
  const sendingRef = useRef(false);
  const packetsRef = useRef(0);
  const controlRef = useRef<ControlState>({
    roll: 0,
    pitch: 0,
    yaw: 0,
    swingMeter: 0,
    pendingSwing: null,
    lastSwingAt: 0,
    lastSeq: -1,
    neutralReady: false,
    neutralRoll: 0,
    neutralPitch: 0,
    neutralYaw: 0,
    racketRoll: 0,
    racketPitch: 0,
    racketYaw: 0,
    lastAccelMag: 9.8,
    swingPrimed: false,
    swingPrimeAxis: null,
    swingPrimeSign: 0,
    swingPrimedAt: 0,
    swingForwardRate: 0,
    swingSideRate: 0,
    swingLiftRate: 0,
  });
  const connectedRef = useRef(false);
  const simRef = useRef<SimState>(createSimState());
  const renderMountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roleParam = params.get("role");
    const sessionParam = params.get("session");

    if (roleParam === "phone") {
      setRole("phone");
    }

    setSession(sessionParam || makeSessionId());
  }, []);

  useEffect(() => {
    if (!session) return;

    if (role !== "host") {
      setPhoneUrl("");
      setQrDataUrl("");
      return;
    }

    const base = `${window.location.origin}${window.location.pathname}`;
    const url = `${base}?role=phone&session=${encodeURIComponent(session)}`;
    setPhoneUrl(url);

    QRCode.toDataURL(url, { margin: 1, width: 240 })
      .then((data) => setQrDataUrl(data))
      .catch(() => setQrDataUrl(""));
  }, [role, session]);

  useEffect(() => {
    if (role !== "host" || !session) return;

    let mounted = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/motion?session=${encodeURIComponent(session)}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (mounted && data?.entry) {
          setLatest(data.entry as StoreEntry);
        }
      } catch {
        // Ignore transient errors.
      }
    };

    const interval = window.setInterval(poll, 40);
    poll();

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [role, session]);

  useEffect(() => {
    const interval = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  const connected = useMemo(() => {
    if (!latest) return false;
    return clock - latest.t < CONNECTION_TIMEOUT_MS;
  }, [clock, latest]);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    if (!latest?.sample) return;

    const control = controlRef.current;
    if (latest.seq === control.lastSeq) return;
    control.lastSeq = latest.seq;

    updateControlFromSample(control, latest.sample, latest.t);
    setNeutralReady(control.neutralReady);

    if (control.swingMeter > SWING_TRIGGER && latest.t - control.lastSwingAt > SWING_REARM_MS) {
      const dynamicRoll = clamp(control.roll * 0.7 + control.swingSideRate / 210, -1, 1);
      const dynamicPitch = clamp(control.pitch * 0.64 + control.swingLiftRate / 230, -1, 1);
      const dynamicStrength = clamp(
        control.swingMeter * 1.05 + clamp((control.swingForwardRate - 120) / 380, 0, 0.32),
        0.2,
        1,
      );
      control.pendingSwing = {
        strength: dynamicStrength,
        roll: dynamicRoll,
        pitch: dynamicPitch,
        at: latest.t,
      };
      control.lastSwingAt = latest.t;
      control.swingForwardRate = 0;
    }
  }, [latest]);

  useEffect(() => {
    if (role !== "phone") return;

    const hasMotion = "DeviceMotionEvent" in window;
    const hasOrientation = "DeviceOrientationEvent" in window;
    setSensorAvailable(hasMotion || hasOrientation);

    const motionCtor = (
      window as Window & { DeviceMotionEvent?: PermissionRequestCapable }
    ).DeviceMotionEvent;
    const orientationCtor = (
      window as Window & { DeviceOrientationEvent?: PermissionRequestCapable }
    ).DeviceOrientationEvent;

    if (!motionCtor?.requestPermission && !orientationCtor?.requestPermission) {
      setPermission("granted");
    }
  }, [role]);

  useEffect(() => {
    if (role !== "phone" || !session) return;

    latestRef.current = blankSample();
    packetsRef.current = 0;
    setPhoneTelemetry({ roll: 0, pitch: 0, swing: 0, packets: 0 });

    let mounted = true;
    let lastPreview = 0;
    let previewAccelMag = 9.8;

    const publishPreview = () => {
      const now = performance.now();
      if (now - lastPreview < 100) return;
      lastPreview = now;

      const sample = latestRef.current;
      const roll = getRawRoll(sample);
      const pitch = getRawPitch(sample);
      const swing = analyzeSwing(sample, previewAccelMag);
      previewAccelMag = swing.accelMagnitude;

      setPhoneTelemetry((prev) => ({
        ...prev,
        roll: roll == null ? prev.roll : clamp(roll / 45, -1, 1),
        pitch: pitch == null ? prev.pitch : clamp((pitch - 20) / 65, -1, 1),
        swing: swing.strength,
      }));
    };

    const motionHandler = (event: DeviceMotionEvent) => {
      const sample = latestRef.current ?? blankSample();
      sample.rotationRate = event.rotationRate
        ? {
            alpha: event.rotationRate.alpha ?? null,
            beta: event.rotationRate.beta ?? null,
            gamma: event.rotationRate.gamma ?? null,
          }
        : null;
      sample.acceleration = event.acceleration
        ? {
            x: event.acceleration.x ?? null,
            y: event.acceleration.y ?? null,
            z: event.acceleration.z ?? null,
          }
        : null;
      sample.accelerationIncludingGravity = event.accelerationIncludingGravity
        ? {
            x: event.accelerationIncludingGravity.x ?? null,
            y: event.accelerationIncludingGravity.y ?? null,
            z: event.accelerationIncludingGravity.z ?? null,
          }
        : null;
      sample.interval = event.interval ?? null;

      latestRef.current = sample;
      publishPreview();
    };

    const orientationHandler = (event: DeviceOrientationEvent) => {
      const sample = latestRef.current ?? blankSample();
      sample.orientation = {
        alpha: event.alpha ?? null,
        beta: event.beta ?? null,
        gamma: event.gamma ?? null,
        absolute: event.absolute ?? null,
      };

      latestRef.current = sample;
      publishPreview();
    };

    window.addEventListener("devicemotion", motionHandler);
    window.addEventListener("deviceorientation", orientationHandler);

    const interval = window.setInterval(async () => {
      if (sendingRef.current || !mounted) return;
      sendingRef.current = true;

      try {
        await fetch("/api/motion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session, sample: latestRef.current }),
        });

        packetsRef.current += 1;
        if (packetsRef.current % 4 === 0) {
          setPhoneTelemetry((prev) => ({ ...prev, packets: packetsRef.current }));
        }
      } catch {
        // Ignore transient network errors.
      } finally {
        sendingRef.current = false;
      }
    }, 33);

    return () => {
      mounted = false;
      window.removeEventListener("devicemotion", motionHandler);
      window.removeEventListener("deviceorientation", orientationHandler);
      window.clearInterval(interval);
    };
  }, [role, session]);

  useEffect(() => {
    if (role !== "host") return;

    simRef.current = createSimState();
    controlRef.current = {
      roll: 0,
      pitch: 0,
      yaw: 0,
      swingMeter: 0,
      pendingSwing: null,
      lastSwingAt: 0,
      lastSeq: -1,
      neutralReady: false,
      neutralRoll: 0,
      neutralPitch: 0,
      neutralYaw: 0,
      racketRoll: 0,
      racketPitch: 0,
      racketYaw: 0,
      lastAccelMag: 9.8,
      swingPrimed: false,
      swingPrimeAxis: null,
      swingPrimeSign: 0,
      swingPrimedAt: 0,
      swingForwardRate: 0,
      swingSideRate: 0,
      swingLiftRate: 0,
    };
    setGameHud({
      player: 0,
      cpu: 0,
      rally: 0,
      winner: null,
      status: "Swing your phone to serve",
    });
    setControlHud({ roll: 0, pitch: 0, swing: 0 });
    setHostPhase("calibration");
    setNeutralReady(false);
  }, [role]);

  useEffect(() => {
    if (role !== "host") return;
    if (hostPhase !== "game") return;
    if (!renderMountRef.current) return;

    const mount = renderMountRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0c2138");
    scene.fog = new THREE.Fog(0x0c2138, 28, 58);

    const camera = new THREE.PerspectiveCamera(
      69,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.1,
      120,
    );
    camera.position.set(0, 1.66, BASELINE_PLAYER_Z + 0.72);
    camera.lookAt(0, 1.1, -2.8);
    scene.add(camera);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xcde8ff, 0x27435e, 0.7);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(-5, 12, 8);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 1;
    dir.shadow.camera.far = 52;
    dir.shadow.camera.left = -16;
    dir.shadow.camera.right = 16;
    dir.shadow.camera.top = 18;
    dir.shadow.camera.bottom = -18;
    scene.add(dir);

    const arena = new THREE.Mesh(
      new THREE.PlaneGeometry(48, 58),
      new THREE.MeshStandardMaterial({
        color: 0x315572,
        roughness: 0.94,
        metalness: 0.02,
      }),
    );
    arena.rotation.x = -Math.PI / 2;
    arena.receiveShadow = true;
    scene.add(arena);

    const court = new THREE.Mesh(
      new THREE.BoxGeometry(COURT_HALF_WIDTH * 2, 0.08, COURT_HALF_LENGTH * 2),
      new THREE.MeshStandardMaterial({
        color: 0x1f6b8d,
        roughness: 0.78,
        metalness: 0.04,
      }),
    );
    court.receiveShadow = true;
    scene.add(court);

    const lineMaterial = new THREE.LineBasicMaterial({ color: 0xe2f0ff });
    const lines = new THREE.Group();
    const addLine = (x1: number, z1: number, x2: number, z2: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x1, 0.05, z1),
        new THREE.Vector3(x2, 0.05, z2),
      ]);
      lines.add(new THREE.Line(g, lineMaterial));
    };

    addLine(-COURT_HALF_WIDTH, -COURT_HALF_LENGTH, COURT_HALF_WIDTH, -COURT_HALF_LENGTH);
    addLine(-COURT_HALF_WIDTH, COURT_HALF_LENGTH, COURT_HALF_WIDTH, COURT_HALF_LENGTH);
    addLine(-COURT_HALF_WIDTH, -COURT_HALF_LENGTH, -COURT_HALF_WIDTH, COURT_HALF_LENGTH);
    addLine(COURT_HALF_WIDTH, -COURT_HALF_LENGTH, COURT_HALF_WIDTH, COURT_HALF_LENGTH);
    addLine(-COURT_HALF_WIDTH, NET_Z, COURT_HALF_WIDTH, NET_Z);
    addLine(-COURT_HALF_WIDTH, -SERVICE_LINE_Z, COURT_HALF_WIDTH, -SERVICE_LINE_Z);
    addLine(-COURT_HALF_WIDTH, SERVICE_LINE_Z, COURT_HALF_WIDTH, SERVICE_LINE_Z);
    addLine(0, -SERVICE_LINE_Z, 0, SERVICE_LINE_Z);
    scene.add(lines);

    const net = new THREE.Mesh(
      new THREE.BoxGeometry(COURT_HALF_WIDTH * 2 + 0.16, NET_HEIGHT, 0.08),
      new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.62, metalness: 0.04 }),
    );
    net.position.set(0, NET_HEIGHT / 2, NET_Z);
    net.castShadow = true;
    scene.add(net);

    const topTape = new THREE.Mesh(
      new THREE.BoxGeometry(COURT_HALF_WIDTH * 2 + 0.2, 0.06, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 0.12 }),
    );
    topTape.position.set(0, NET_HEIGHT + 0.03, NET_Z);
    scene.add(topTape);

    const postGeom = new THREE.CylinderGeometry(0.05, 0.06, NET_HEIGHT + 0.45, 14);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xdbeafe, roughness: 0.25, metalness: 0.22 });
    const leftPost = new THREE.Mesh(postGeom, postMat);
    leftPost.position.set(-COURT_HALF_WIDTH - 0.12, (NET_HEIGHT + 0.45) / 2, NET_Z);
    const rightPost = leftPost.clone();
    rightPost.position.x = COURT_HALF_WIDTH + 0.12;
    scene.add(leftPost, rightPost);

    const ballMesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 24, 24),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.18, metalness: 0.05 }),
    );
    ballMesh.castShadow = true;
    scene.add(ballMesh);

    const ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(BALL_RADIUS * 1.9, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }),
    );
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.position.y = 0.01;
    scene.add(ballShadow);

    const playerVisual = createAvatarVisual("player");
    playerVisual.group.position.set(0, 0, BASELINE_PLAYER_Z);
    playerVisual.group.castShadow = true;
    playerVisual.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
      }
    });
    scene.add(playerVisual.group);
    playerVisual.group.visible = false;

    const cpuVisual = createAvatarVisual("cpu");
    cpuVisual.group.position.set(0, 0, BASELINE_CPU_Z);
    cpuVisual.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
      }
    });
    scene.add(cpuVisual.group);

    const povRacket = createPovRacketVisual();
    camera.add(povRacket.group);

    const resize = () => {
      const w = mount.clientWidth;
      const h = Math.max(1, mount.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    };
    window.addEventListener("resize", resize);

    const sim = simRef.current;
    let raf = 0;
    let lastFrame = performance.now();
    let lastHudCommit = 0;

    const syncHud = () => {
      const match = sim.match;
      const control = controlRef.current;
      setGameHud({
        player: match.playerScore,
        cpu: match.cpuScore,
        rally: match.rally,
        winner: match.winner,
        status: match.status,
      });
      setControlHud({
        roll: control.roll,
        pitch: control.pitch,
        swing: control.swingMeter,
      });
    };

    const awardPoint = (winner: ScoreOwner, reason: string) => {
      const match = sim.match;
      if (match.winner) return;

      if (winner === "player") {
        match.playerScore += 1;
      } else {
        match.cpuScore += 1;
      }

      match.rally = 0;
      match.status = reason;
      match.lastHitter = null;
      match.expectedBounce = null;
      match.bounced = false;
      match.serveInFlight = false;

      sim.player.swingT = 0;
      sim.player.used = false;
      sim.player.cooldown = 0;
      sim.player.flash = 0;
      sim.cpu.swingT = 0;
      sim.cpu.used = false;
      sim.cpu.cooldown = 0;
      sim.cpu.flash = 0;

      if (match.playerScore >= POINTS_TO_WIN || match.cpuScore >= POINTS_TO_WIN) {
        match.winner = winner;
        match.status = winner === "player" ? "You won the match" : "CPU won the match";
        sim.ballPos.set(0, BALL_RADIUS, 0);
        sim.ballVel.set(0, 0, 0);
        sim.ballSpinSide = 0;
        sim.ballSpinTop = 0;
        syncHud();
        return;
      }

      match.server = match.server === "player" ? "cpu" : "player";
      match.serveTimer = 0.85;
      placeServeBall(sim, match.server);
      syncHud();
    };

    const updateAvatarVisual = (
      visual: AvatarVisual,
      avatar: AvatarSim,
      side: ScoreOwner,
    ) => {
      const progress = avatar.swingT > 0 ? clamp(1 - avatar.swingT / SWING_DURATION, 0, 1) : 0;
      const baseZ = side === "player" ? -0.82 : 0.82;
      const sweepZ = side === "player" ? 2.25 : -2.25;

      visual.swingPivot.rotation.set(
        0.25 + progress * 0.55 + avatar.pitch * 0.25,
        side === "player" ? 0.2 : -0.2,
        baseZ + sweepZ * progress + avatar.roll * (side === "player" ? 0.45 : -0.45),
      );

      if (avatar.flash > 0) {
        visual.bodyMaterial.emissive.setHex(side === "player" ? 0x064e3b : 0x7c2d12);
        visual.bodyMaterial.emissiveIntensity = 0.8;
        visual.racketMaterial.emissive.setHex(0xfef08a);
        visual.racketMaterial.emissiveIntensity = 0.65;
      } else {
        visual.bodyMaterial.emissive.setHex(0x000000);
        visual.bodyMaterial.emissiveIntensity = 0;
        visual.racketMaterial.emissive.setHex(0x000000);
        visual.racketMaterial.emissiveIntensity = 0;
      }
    };

    const animate = (now: number) => {
      const dt = Math.min((now - lastFrame) / 1000, 0.033);
      lastFrame = now;

      const match = sim.match;
      const control = controlRef.current;

      control.swingMeter = Math.max(0, control.swingMeter - dt * 1.3);

      if (
        control.pendingSwing &&
        connectedRef.current &&
        !match.winner &&
        sim.player.cooldown <= 0 &&
        sim.player.swingT <= 0
      ) {
        const event = control.pendingSwing;
        control.pendingSwing = null;
        startSwing(sim.player, event.strength, event.roll, event.pitch);
      }

      const playerLimit = COURT_HALF_WIDTH - 0.6;
      const cpuLimit = COURT_HALF_WIDTH - 0.75;

      if (match.lastHitter === null) {
        sim.player.targetX = clamp(sim.ballPos.x * 0.8, -playerLimit, playerLimit);
        sim.cpu.targetX = clamp(sim.ballPos.x * 0.8, -cpuLimit, cpuLimit);
      } else {
        sim.player.targetX =
          sim.ballVel.z > 0 || sim.ballPos.z > NET_Z
            ? clamp(sim.ballPos.x + sim.ballVel.x * 0.14, -playerLimit, playerLimit)
            : clamp(sim.ballPos.x * 0.35, -1.2, 1.2);

        sim.cpu.targetX =
          sim.ballVel.z < 0 || sim.ballPos.z < NET_Z
            ? clamp(sim.ballPos.x + sim.ballVel.x * 0.14, -cpuLimit, cpuLimit)
            : clamp(sim.ballPos.x * 0.35, -1.2, 1.2);
      }

      sim.player.x = approach(sim.player.x, sim.player.targetX, PLAYER_SPEED * dt);
      sim.cpu.x = approach(sim.cpu.x, sim.cpu.targetX, CPU_SPEED * dt);

      for (const avatar of [sim.player, sim.cpu]) {
        avatar.cooldown = Math.max(0, avatar.cooldown - dt);
        avatar.flash = Math.max(0, avatar.flash - dt);
        if (avatar.swingT > 0) {
          avatar.swingT = Math.max(0, avatar.swingT - dt);
        }
      }

      let pointEnded = false;

      if (!match.winner && connectedRef.current) {
        if (match.lastHitter === null) {
          match.serveTimer = Math.max(0, match.serveTimer - dt);

          const serverAvatar = match.server === "player" ? sim.player : sim.cpu;
          const serveZ = match.server === "player" ? BASELINE_PLAYER_Z : BASELINE_CPU_Z;
          sim.ballPos.x += (serverAvatar.x - sim.ballPos.x) * 0.22;
          sim.ballPos.z = serveZ;
          sim.ballPos.y = 1.48 + Math.sin(now * 0.0065) * 0.08;

          if (match.server === "player") {
            if (match.serveTimer <= 0 && sim.player.swingT > 0 && !sim.player.used) {
              const progress = 1 - sim.player.swingT / SWING_DURATION;
              if (progress > 0.18 && progress < 0.8) {
                strikeBall(sim, "player", sim.player.power, sim.player.roll, sim.player.pitch, true);
                sim.player.used = true;
                sim.player.flash = 0.11;
                match.status = "Rally live";
              }
            }
          } else {
            if (match.serveTimer <= 0 && sim.cpu.swingT <= 0 && sim.cpu.cooldown <= 0) {
              startSwing(
                sim.cpu,
                0.55 + Math.random() * 0.35,
                clamp((Math.random() - 0.5) * 0.9, -1, 1),
                clamp((Math.random() - 0.15) * 0.7, -1, 1),
              );
            }
            if (sim.cpu.swingT > 0 && !sim.cpu.used) {
              const progress = 1 - sim.cpu.swingT / SWING_DURATION;
              if (progress > 0.24 && progress < 0.78) {
                strikeBall(sim, "cpu", sim.cpu.power, sim.cpu.roll, sim.cpu.pitch, true);
                sim.cpu.used = true;
                sim.cpu.flash = 0.1;
              }
            }
          }
        } else {
          const prevZ = sim.ballPos.z;
          const prevY = sim.ballPos.y;

          sim.ballVel.y -= GRAVITY * dt;
          sim.ballVel.x *= 1 - AIR_DRAG * dt;
          sim.ballVel.z *= 1 - AIR_DRAG * dt;
          sim.ballVel.x += sim.ballSpinSide * 0.11 * dt;
          sim.ballVel.y -= Math.max(sim.ballSpinTop, 0) * 0.13 * dt;
          sim.ballVel.z += -Math.sign(sim.ballVel.z || 1) * sim.ballSpinTop * 0.028 * dt;
          sim.ballSpinSide *= 1 - Math.min(0.42 * dt, 0.25);
          sim.ballSpinTop *= 1 - Math.min(0.52 * dt, 0.28);
          sim.ballPos.addScaledVector(sim.ballVel, dt);

          if (
            sim.ballVel.z < -0.45 &&
            sim.ballPos.z < -4.2 &&
            sim.cpu.swingT <= 0 &&
            sim.cpu.cooldown <= 0
          ) {
            const bias = clamp(0.9 - Math.abs(sim.ballPos.x - sim.cpu.x), 0, 0.9);
            startSwing(
              sim.cpu,
              clamp(0.45 + bias * 0.3 + Math.random() * 0.25, 0.45, 0.95),
              clamp((sim.ballPos.x - sim.cpu.x) * 0.65 + (Math.random() - 0.5) * 0.28, -1, 1),
              clamp((Math.random() - 0.2) * 0.7, -1, 1),
            );
          }

          if (sim.player.swingT > 0 && !sim.player.used && canPlayerHit(sim)) {
            strikeBall(sim, "player", sim.player.power, sim.player.roll, sim.player.pitch, false);
            sim.player.used = true;
            sim.player.flash = 0.12;
          }

          if (sim.cpu.swingT > 0 && !sim.cpu.used && canCpuHit(sim)) {
            strikeBall(sim, "cpu", sim.cpu.power, sim.cpu.roll, sim.cpu.pitch, false);
            sim.cpu.used = true;
            sim.cpu.flash = 0.12;
          }

          if (match.lastHitter) {
            const crossedNet =
              (prevZ > NET_Z && sim.ballPos.z <= NET_Z) ||
              (prevZ < NET_Z && sim.ballPos.z >= NET_Z);

            if (crossedNet) {
              const dz = sim.ballPos.z - prevZ;
              const t = Math.abs(dz) < 1e-6 ? 0 : (NET_Z - prevZ) / dz;
              const yAtNet = prevY + (sim.ballPos.y - prevY) * t;
              if (yAtNet < NET_HEIGHT + BALL_RADIUS * 0.65) {
                awardPoint(opponent(match.lastHitter), "Into the net");
                pointEnded = true;
              }
            }
          }

          if (!pointEnded && sim.ballPos.y <= BALL_RADIUS && match.lastHitter) {
            sim.ballPos.y = BALL_RADIUS;

            const inBounds =
              Math.abs(sim.ballPos.x) <= COURT_HALF_WIDTH &&
              sim.ballPos.z >= -COURT_HALF_LENGTH &&
              sim.ballPos.z <= COURT_HALF_LENGTH;
            const bounceSide: ScoreOwner = sim.ballPos.z >= NET_Z ? "player" : "cpu";

            if (!inBounds || bounceSide !== match.expectedBounce) {
              awardPoint(opponent(match.lastHitter), "Shot out");
              pointEnded = true;
            } else if (match.bounced) {
              awardPoint(match.lastHitter, "Second bounce");
              pointEnded = true;
            } else {
              if (
                match.serveInFlight &&
                (Math.abs(sim.ballPos.z) > SERVICE_LINE_Z || Math.abs(sim.ballPos.x) > COURT_HALF_WIDTH)
              ) {
                awardPoint(opponent(match.lastHitter), "Service fault");
                pointEnded = true;
              }
            }

            if (!pointEnded && !match.bounced) {
              match.bounced = true;
              if (match.serveInFlight) {
                match.serveInFlight = false;
              }
              sim.ballVel.y = Math.max(Math.abs(sim.ballVel.y) * GROUND_BOUNCE, 2.6);
              sim.ballVel.x = sim.ballVel.x * 0.88 + sim.ballSpinSide * 0.18;
              sim.ballVel.z = sim.ballVel.z * 0.91 - Math.sign(sim.ballVel.z || 1) * sim.ballSpinTop * 0.08;
              sim.ballSpinSide *= 0.52;
              sim.ballSpinTop *= 0.36;
            }
          }

          if (
            !pointEnded &&
            match.lastHitter &&
            (Math.abs(sim.ballPos.x) > COURT_HALF_WIDTH + 0.9 ||
              sim.ballPos.z < -COURT_HALF_LENGTH - 1.6 ||
              sim.ballPos.z > COURT_HALF_LENGTH + 1.6 ||
              sim.ballPos.y > 12.5)
          ) {
            awardPoint(opponent(match.lastHitter), "Ball sailed long");
            pointEnded = true;
          }
        }
      }

      playerVisual.group.position.x = sim.player.x;
      cpuVisual.group.position.x = sim.cpu.x;
      updateAvatarVisual(playerVisual, sim.player, "player");
      updateAvatarVisual(cpuVisual, sim.cpu, "cpu");

      ballMesh.position.copy(sim.ballPos);
      ballShadow.position.set(sim.ballPos.x, 0.01, sim.ballPos.z);
      const shadowScale = clamp(1.8 - sim.ballPos.y * 0.22, 0.55, 1.6);
      ballShadow.scale.set(shadowScale, shadowScale, shadowScale);

      camera.position.x = THREE.MathUtils.lerp(camera.position.x, sim.player.x * 0.98, 0.22);
      camera.position.y = THREE.MathUtils.lerp(camera.position.y, 1.66, 0.22);
      camera.position.z = THREE.MathUtils.lerp(camera.position.z, BASELINE_PLAYER_Z + 0.72, 0.22);

      const lookX = THREE.MathUtils.lerp(sim.player.x * 0.2, sim.ballPos.x, 0.72);
      const lookY = clamp(sim.ballPos.y * 0.72 + 0.86, 0.95, 3.9);
      const lookZ = THREE.MathUtils.lerp(-2.8, sim.ballPos.z, 0.88);
      camera.lookAt(lookX, lookY, lookZ);

      povRacket.pivot.rotation.set(
        -0.26 + control.racketPitch,
        0.08 + control.racketYaw * 0.85,
        -0.86 - control.racketRoll,
      );

      if (sim.player.flash > 0) {
        povRacket.frameMaterial.emissive.setHex(0xfef08a);
        povRacket.frameMaterial.emissiveIntensity = 0.52;
      } else {
        povRacket.frameMaterial.emissive.setHex(0x000000);
        povRacket.frameMaterial.emissiveIntensity = 0;
      }

      renderer.render(scene, camera);

      if (now - lastHudCommit > 110) {
        lastHudCommit = now;
        syncHud();
      }

      raf = window.requestAnimationFrame(animate);
    };

    resize();
    syncHud();
    raf = window.requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(raf);

      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((mat) => mat.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
      lineMaterial.dispose();
      renderer.dispose();

      if (mount.contains(renderer.domElement)) {
        mount.removeChild(renderer.domElement);
      }
    };
  }, [role, hostPhase]);

  const requestPermission = async () => {
    try {
      const motionCtor = (
        window as Window & { DeviceMotionEvent?: PermissionRequestCapable }
      ).DeviceMotionEvent;
      const orientationCtor = (
        window as Window & { DeviceOrientationEvent?: PermissionRequestCapable }
      ).DeviceOrientationEvent;

      const requests: Array<Promise<"granted" | "denied">> = [];
      if (motionCtor?.requestPermission) {
        requests.push(motionCtor.requestPermission());
      }
      if (orientationCtor?.requestPermission) {
        requests.push(orientationCtor.requestPermission());
      }

      if (requests.length === 0) {
        setPermission("granted");
        return;
      }

      const results = await Promise.all(requests);
      setPermission(results.every((result) => result === "granted") ? "granted" : "denied");
    } catch {
      setPermission("denied");
    }
  };

  const copyPhoneLink = async () => {
    if (!phoneUrl) return;
    try {
      await navigator.clipboard.writeText(phoneUrl);
    } catch {
      // Clipboard can fail in some contexts.
    }
  };

  const resetMatch = () => {
    simRef.current = createSimState();
    controlRef.current.pendingSwing = null;
    controlRef.current.swingMeter = 0;
    controlRef.current.yaw = 0;
    controlRef.current.racketRoll = 0;
    controlRef.current.racketPitch = 0;
    controlRef.current.racketYaw = 0;
    controlRef.current.swingPrimed = false;
    controlRef.current.swingPrimeAxis = null;
    controlRef.current.swingPrimeSign = 0;
    controlRef.current.swingForwardRate = 0;
    controlRef.current.swingSideRate = 0;
    controlRef.current.swingLiftRate = 0;
    setGameHud({
      player: 0,
      cpu: 0,
      rally: 0,
      winner: null,
      status: "Swing your phone to serve",
    });
    setControlHud((prev) => ({ ...prev, swing: 0 }));
  };

  const canLaunchFromCalibration =
    connected &&
    latest?.sample?.orientation != null &&
    typeof latest.sample.orientation.beta === "number" &&
    typeof latest.sample.orientation.gamma === "number";

  const recenterController = () => {
    const control = controlRef.current;
    const sample = latest?.sample ?? null;
    const roll = getRawRoll(sample);
    const pitch = getRawPitch(sample);
    const yaw = getRawYaw(sample);
    if (roll !== null && pitch !== null) {
      control.neutralRoll = roll;
      control.neutralPitch = pitch;
      if (yaw !== null) {
        control.neutralYaw = yaw;
      }
      control.neutralReady = true;
      control.roll = 0;
      control.pitch = 0;
      control.yaw = 0;
      control.racketRoll = 0;
      control.racketPitch = 0;
      control.racketYaw = 0;
      control.swingPrimed = false;
      control.swingPrimeAxis = null;
      control.swingPrimeSign = 0;
      control.swingForwardRate = 0;
      control.swingSideRate = 0;
      control.swingLiftRate = 0;
      setNeutralReady(true);
      setControlHud((prev) => ({ ...prev, roll: 0, pitch: 0 }));
      return true;
    }
    return false;
  };

  const launchGameFromCalibration = () => {
    const calibrated = recenterController();
    if (!calibrated) {
      setGameHud((prev) => ({
        ...prev,
        status: "Cannot calibrate yet. Keep the phone steady and send motion first.",
      }));
      return;
    }
    resetMatch();
    setHostPhase("game");
  };

  const backToCalibration = () => {
    setHostPhase("calibration");
    controlRef.current.pendingSwing = null;
    setGameHud((prev) => ({
      ...prev,
      status: "Calibrate the remote, then launch the game.",
    }));
  };

  const handleManualRecenter = () => {
    const calibrated = recenterController();
    setGameHud((prev) => ({
      ...prev,
      status: calibrated
        ? "Remote calibrated. Launch whenever you are ready."
        : "No sensor sample yet. Keep the phone still for a second and retry.",
    }));
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/70">Pocket Racket</p>
          <h1 className="text-3xl font-semibold">3D Wii-Style Phone Tennis</h1>
          <p className="text-sm text-slate-300/85">
            First-person court view with a racket that mirrors your phone orientation in real time.
          </p>
        </header>

        <div className="grid gap-6 xl:grid-cols-[2fr,1fr]">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm text-slate-400">
                  Role: <span className="text-slate-100">{role === "host" ? "Host" : "Phone"}</span>
                </p>
                <p className="text-sm text-slate-400">
                  Session: <span className="text-slate-100">{session || "..."}</span>
                </p>
              </div>

              {role === "host" && (
                <div className="flex items-center gap-2 rounded-full border border-slate-700/80 px-3 py-1 text-xs">
                  <span
                    className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-slate-500"}`}
                  />
                  {connected ? "Phone connected" : "Waiting for phone"}
                </div>
              )}
            </div>

            {role === "host" ? (
              <div className="mt-4 space-y-4">
                <div className="flex flex-wrap gap-4">
                  <div className="h-36 w-36 rounded-xl bg-slate-800 p-2">
                    {qrDataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={qrDataUrl}
                        alt="Session QR"
                        className="h-full w-full rounded-lg bg-white p-2"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">
                        Generating QR...
                      </div>
                    )}
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
                    <div className="rounded-lg bg-slate-800/70 p-2 break-all text-slate-200">
                      {phoneUrl || "Preparing phone link..."}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={copyPhoneLink}
                        disabled={!phoneUrl}
                        className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 enabled:hover:bg-slate-800 disabled:opacity-40"
                      >
                        Copy Link
                      </button>
                      <button
                        onClick={() => window.open(phoneUrl, "_blank")}
                        disabled={!phoneUrl}
                        className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 enabled:hover:bg-slate-800 disabled:opacity-40"
                      >
                        Open Phone View
                      </button>
                      <button
                        onClick={handleManualRecenter}
                        className="rounded-lg border border-slate-600 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
                      >
                        Recenter Motion
                      </button>
                      {hostPhase === "calibration" ? (
                        <button
                          onClick={launchGameFromCalibration}
                          disabled={!canLaunchFromCalibration}
                          className="rounded-lg border border-cyan-600/70 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 enabled:hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Calibrate & Launch
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={resetMatch}
                            className="rounded-lg border border-cyan-600/70 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/20"
                          >
                            Reset Match
                          </button>
                          <button
                            onClick={backToCalibration}
                            className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
                          >
                            Back to Calibration
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {hostPhase === "calibration" ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Connection</p>
                        <p className="mt-2 text-sm text-slate-200">
                          {connected ? "Phone telemetry streaming" : "Waiting for live packets"}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          Launch unlocks once orientation data is received.
                        </p>
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Neutral Pose</p>
                        <p className="mt-2 text-sm text-slate-200">
                          {neutralReady ? "Calibrated" : "Not calibrated"}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          Hold phone flat like a Wii Remote, then recenter.
                        </p>
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Live Motion</p>
                        <p className="mt-2 text-sm text-slate-200">
                          Roll {controlHud.roll.toFixed(2)} | Pitch {controlHud.pitch.toFixed(2)}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">Swing {controlHud.swing.toFixed(2)}</p>
                      </div>
                    </div>

                    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-sm text-slate-300">
                      <p className="font-medium text-slate-100">Calibration flow</p>
                      <ol className="mt-2 list-decimal space-y-1 pl-4 text-slate-300">
                        <li>Connect the phone and allow sensor access.</li>
                        <li>Hold still in neutral position and press Recenter Motion.</li>
                        <li>Press Calibrate & Launch to start the 3D match.</li>
                      </ol>
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      ref={renderMountRef}
                      className="aspect-[16/9] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950"
                    />

                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">You</p>
                        <p className="mt-1 text-2xl font-semibold text-emerald-300">{gameHud.player}</p>
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">CPU</p>
                        <p className="mt-1 text-2xl font-semibold text-orange-300">{gameHud.cpu}</p>
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Rally</p>
                        <p className="mt-1 text-2xl font-semibold text-slate-100">{gameHud.rally}</p>
                      </div>
                      <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Controller</p>
                        <p className="mt-1 text-sm text-slate-200">
                          Roll {controlHud.roll.toFixed(2)} | Pitch {controlHud.pitch.toFixed(2)}
                        </p>
                        <p className="text-xs text-slate-400">Swing {controlHud.swing.toFixed(2)}</p>
                      </div>
                    </div>

                    {gameHud.winner && (
                      <div
                        className={`rounded-xl border p-3 text-sm ${
                          gameHud.winner === "player"
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                            : "border-rose-500/40 bg-rose-500/10 text-rose-200"
                        }`}
                      >
                        {gameHud.winner === "player"
                          ? "Match won. Timing and angle control worked."
                          : "CPU won this match. Try faster forward swings and earlier timing."}
                      </div>
                    )}
                  </>
                )}

                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-sm text-slate-300">
                  {gameHud.status}
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-4 text-sm text-slate-200">
                <p>
                  Hold your phone like a Wii Remote. Swing forward to hit and rotate your wrist to direct the ball.
                </p>

                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <div className="flex items-center justify-between">
                    <span>Sensor permission</span>
                    <span className="text-xs text-slate-400">{permission}</span>
                  </div>
                  <button
                    onClick={requestPermission}
                    className="mt-3 w-full rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
                  >
                    Enable Motion Access
                  </button>
                  {!sensorAvailable && (
                    <p className="mt-3 text-xs text-rose-300">
                      This browser/device does not expose motion sensors.
                    </p>
                  )}
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Live telemetry</p>
                  <p className="mt-2 text-sm text-slate-300">
                    Roll {phoneTelemetry.roll.toFixed(2)} | Pitch {phoneTelemetry.pitch.toFixed(2)}
                  </p>
                  <p className="mt-1 text-sm text-slate-300">Swing {phoneTelemetry.swing.toFixed(2)}</p>
                  <p className="mt-1 text-xs text-slate-400">Packets sent: {phoneTelemetry.packets}</p>
                  <div className="mt-3 h-2 overflow-hidden rounded bg-slate-800">
                    <div
                      className="h-full bg-cyan-400 transition-all"
                      style={{ width: `${clamp(phoneTelemetry.swing, 0, 1) * 100}%` }}
                    />
                  </div>
                </div>

                <p className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-400">
                  Use a backswing then a forward release. Wrist roll and lift shape cross-court, topspin, and slice.
                </p>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-6">
            <h2 className="text-lg font-semibold">3D Wii-Style Flow</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm text-slate-300">
              <li>Run host on PC and scan the QR code with your phone.</li>
              <li>Enable motion sensors on phone.</li>
              <li>Use tennis-like backswing then release to trigger each shot.</li>
              <li>Roll and lift your wrist through contact to shape direction and spin.</li>
            </ol>
            <p className="mt-4 text-xs text-slate-500">
              POV camera is active during play, with direct phone-to-racket orientation mapping.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
