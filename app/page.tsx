"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";

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
  acceleration: { x: number | null; y: number | null; z: number | null } | null;
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

type ControlState = {
  roll: number;
  pitch: number;
  swing: number;
  pending: { strength: number; roll: number; pitch: number } | null;
  lastSwingAt: number;
  lastSeq: number;
};

type BallState = {
  x: number;
  z: number;
  y: number;
  vx: number;
  vz: number;
  vy: number;
  radius: number;
};

type AvatarState = {
  x: number;
  target: number;
  swing: number;
  power: number;
  roll: number;
  pitch: number;
  used: boolean;
  cooldown: number;
  flash: number;
};

type GameState = {
  ball: BallState;
  player: AvatarState;
  cpu: AvatarState;
  playerScore: number;
  cpuScore: number;
  rally: number;
  winner: ScoreOwner | null;
  server: ScoreOwner;
  serveDelay: number;
  lastHitter: ScoreOwner | null;
  expectedBounce: ScoreOwner | null;
  bounced: boolean;
  status: string;
};

type PermissionRequestCapable = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const VIEW_W = 960;
const VIEW_H = 540;
const HALF_X = 1.04;
const BASE_PLAYER = 0.88;
const BASE_CPU = 0.12;
const NET_Z = 0.5;
const NET_H = 0.82;

const PLAYER_SPEED = 2.9;
const CPU_SPEED = 2.4;
const GRAVITY = 7.8;
const BOUNCE = 0.62;
const AIR = 0.04;

const HIT_X = 0.23;
const HIT_Y_MIN = 0.18;
const HIT_Y_MAX = 1.45;

const SWING_DUR = 0.31;
const SWING_COOLDOWN = 0.16;
const SWING_TRIGGER = 0.5;
const SWING_REARM_MS = 260;

const WIN_SCORE = 7;
const CONNECTION_TIMEOUT_MS = 1200;

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

function opponent(owner: ScoreOwner): ScoreOwner {
  return owner === "player" ? "cpu" : "player";
}

function getRoll(sample: MotionSample | null): number | null {
  const gamma = sample?.orientation?.gamma;
  return typeof gamma === "number" ? clamp(gamma / 48, -1, 1) : null;
}

function getPitch(sample: MotionSample | null): number | null {
  const beta = sample?.orientation?.beta;
  return typeof beta === "number" ? clamp((beta - 20) / 65, -1, 1) : null;
}

function getSwing(sample: MotionSample | null): number {
  const rate = sample?.rotationRate;
  const g = sample?.accelerationIncludingGravity;

  const a = rate?.alpha ?? 0;
  const b = rate?.beta ?? 0;
  const c = rate?.gamma ?? 0;
  const gyro = Math.sqrt(a ** 2 + b ** 2 + c ** 2);
  const gyroSwing = clamp((gyro - 62) / 315, 0, 1);

  const gx = g?.x ?? 0;
  const gy = g?.y ?? 0;
  const gz = g?.z ?? 0;
  const gm = Math.sqrt(gx ** 2 + gy ** 2 + gz ** 2);
  const accelSwing = clamp((Math.abs(gm - 9.8) - 1) / 9, 0, 1);

  return Math.max(gyroSwing, accelSwing);
}

function createAvatar(): AvatarState {
  return {
    x: 0,
    target: 0,
    swing: 0,
    power: 0,
    roll: 0,
    pitch: 0,
    used: false,
    cooldown: 0,
    flash: 0,
  };
}

function placeServeBall(state: GameState, server: ScoreOwner) {
  const avatar = server === "player" ? state.player : state.cpu;
  state.ball.x = clamp(avatar.x + (server === "player" ? 0.06 : -0.06), -HALF_X * 0.86, HALF_X * 0.86);
  state.ball.z = server === "player" ? BASE_PLAYER : BASE_CPU;
  state.ball.y = 1.02;
  state.ball.vx = 0;
  state.ball.vz = 0;
  state.ball.vy = 0;
}

function createGame(): GameState {
  const state: GameState = {
    ball: { x: 0, z: BASE_PLAYER, y: 1.02, vx: 0, vz: 0, vy: 0, radius: 0.035 },
    player: createAvatar(),
    cpu: createAvatar(),
    playerScore: 0,
    cpuScore: 0,
    rally: 0,
    winner: null,
    server: "player",
    serveDelay: 0.9,
    lastHitter: null,
    expectedBounce: null,
    bounced: false,
    status: "Swing your phone to serve",
  };
  placeServeBall(state, "player");
  return state;
}

function startSwing(avatar: AvatarState, strength: number, roll: number, pitch: number) {
  avatar.swing = SWING_DUR;
  avatar.power = clamp(strength, 0.2, 1);
  avatar.roll = clamp(roll, -1, 1);
  avatar.pitch = clamp(pitch, -1, 1);
  avatar.used = false;
  avatar.cooldown = SWING_COOLDOWN;
}

function strike(state: GameState, hitter: ScoreOwner, power: number, roll: number, pitch: number, serve: boolean) {
  const toward = hitter === "player" ? -1 : 1;
  const b = state.ball;

  b.vx = clamp(roll * 1.45 + (hitter === "cpu" ? (Math.random() - 0.5) * 0.32 : 0), -2.2, 2.2);
  b.vz = toward * ((serve ? 2.7 : 2.85) + power * 1.55);
  b.vy = (serve ? 2.45 : 2.2) + power * 1.2 + clamp(-pitch * 0.55, -0.2, 0.65);
  b.y = clamp(b.y, 0.3, 1.45);

  if (serve) {
    if (hitter === "player") {
      b.z = BASE_PLAYER - 0.02;
      b.x = clamp(state.player.x + roll * 0.03, -HALF_X + 0.06, HALF_X - 0.06);
    } else {
      b.z = BASE_CPU + 0.02;
      b.x = clamp(state.cpu.x - roll * 0.03, -HALF_X + 0.06, HALF_X - 0.06);
    }
  }

  state.lastHitter = hitter;
  state.expectedBounce = opponent(hitter);
  state.bounced = false;
  state.rally = Math.max(1, state.rally + 1);
}

function canPlayerHit(state: GameState) {
  const b = state.ball;
  return b.vz > 0 && b.z > 0.63 && b.z < 0.99 && Math.abs(b.x - state.player.x) < HIT_X && b.y > HIT_Y_MIN && b.y < HIT_Y_MAX;
}

function canCpuHit(state: GameState) {
  const b = state.ball;
  return b.vz < 0 && b.z < 0.37 && b.z > 0.01 && Math.abs(b.x - state.cpu.x) < HIT_X && b.y > HIT_Y_MIN && b.y < HIT_Y_MAX;
}

function approach(current: number, target: number, maxDelta: number) {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

function project(x: number, z: number, y: number) {
  const p = 0.42 + z * 0.86;
  return {
    x: VIEW_W / 2 + x * 305 * p,
    y: 58 + z * 412 - y * 145 * p,
    p,
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
  const [clock, setClock] = useState(Date.now());
  const [phoneTelemetry, setPhoneTelemetry] = useState({ roll: 0, pitch: 0, swing: 0, packets: 0 });
  const [gameHud, setGameHud] = useState({ player: 0, cpu: 0, rally: 0, winner: null as ScoreOwner | null, status: "Swing your phone to serve" });
  const [controlHud, setControlHud] = useState({ roll: 0, pitch: 0, swing: 0 });

  const latestRef = useRef<MotionSample | null>(null);
  const sendingRef = useRef(false);
  const packetsRef = useRef(0);
  const controlRef = useRef<ControlState>({ roll: 0, pitch: 0, swing: 0, pending: null, lastSwingAt: 0, lastSeq: -1 });
  const connectedRef = useRef(false);
  const gameRef = useRef<GameState>(createGame());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roleParam = params.get("role");
    const sessionParam = params.get("session");
    if (roleParam === "phone") setRole("phone");
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
        const res = await fetch(`/api/motion?session=${encodeURIComponent(session)}`, { cache: "no-store" });
        const data = await res.json();
        if (mounted && data?.entry) setLatest(data.entry as StoreEntry);
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

    const roll = getRoll(latest.sample);
    const pitch = getPitch(latest.sample);
    const swing = getSwing(latest.sample);

    if (roll !== null) control.roll = roll;
    if (pitch !== null) control.pitch = pitch;

    control.swing = Math.max(control.swing * 0.58, swing);
    if (swing > SWING_TRIGGER && latest.t - control.lastSwingAt > SWING_REARM_MS) {
      control.pending = {
        strength: clamp(swing * 1.18, 0.2, 1),
        roll: control.roll,
        pitch: control.pitch,
      };
      control.lastSwingAt = latest.t;
    }
  }, [latest]);

  useEffect(() => {
    if (role !== "phone") return;

    const hasMotion = "DeviceMotionEvent" in window;
    const hasOrientation = "DeviceOrientationEvent" in window;
    setSensorAvailable(hasMotion || hasOrientation);

    const motionCtor = (window as Window & { DeviceMotionEvent?: PermissionRequestCapable }).DeviceMotionEvent;
    const orientationCtor = (window as Window & { DeviceOrientationEvent?: PermissionRequestCapable }).DeviceOrientationEvent;

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

    const publishPreview = () => {
      const now = performance.now();
      if (now - lastPreview < 100) return;
      lastPreview = now;

      const sample = latestRef.current;
      const roll = getRoll(sample);
      const pitch = getPitch(sample);
      const swing = getSwing(sample);

      setPhoneTelemetry((prev) => ({
        ...prev,
        roll: roll ?? prev.roll,
        pitch: pitch ?? prev.pitch,
        swing,
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
        // Ignore transient errors.
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
    gameRef.current = createGame();
    controlRef.current = { roll: 0, pitch: 0, swing: 0, pending: null, lastSwingAt: 0, lastSeq: -1 };
    setGameHud({ player: 0, cpu: 0, rally: 0, winner: null, status: "Swing your phone to serve" });
    setControlHud({ roll: 0, pitch: 0, swing: 0 });
  }, [role]);

  useEffect(() => {
    if (role !== "host") return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastFrame = performance.now();
    let lastHud = 0;
    let dpr = 1;
    let vw = 1;
    let vh = 1;

    const syncHud = () => {
      const state = gameRef.current;
      const control = controlRef.current;
      setGameHud({
        player: state.playerScore,
        cpu: state.cpuScore,
        rally: state.rally,
        winner: state.winner,
        status: state.status,
      });
      setControlHud({ roll: control.roll, pitch: control.pitch, swing: control.swing });
    };

    const pointTo = (winner: ScoreOwner, reason: string) => {
      const state = gameRef.current;
      if (state.winner) return;

      if (winner === "player") state.playerScore += 1;
      else state.cpuScore += 1;

      state.rally = 0;
      state.status = reason;
      state.lastHitter = null;
      state.expectedBounce = null;
      state.bounced = false;
      state.player.swing = 0;
      state.player.cooldown = 0;
      state.player.used = false;
      state.player.flash = 0;
      state.cpu.swing = 0;
      state.cpu.cooldown = 0;
      state.cpu.used = false;
      state.cpu.flash = 0;

      if (state.playerScore >= WIN_SCORE || state.cpuScore >= WIN_SCORE) {
        state.winner = winner;
        state.status = winner === "player" ? "You won the match" : "CPU won the match";
        state.ball = { ...state.ball, x: 0, z: NET_Z, y: 0, vx: 0, vz: 0, vy: 0 };
        syncHud();
        return;
      }

      state.server = state.server === "player" ? "cpu" : "player";
      state.serveDelay = 0.85;
      placeServeBall(state, state.server);
      syncHud();
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      vw = Math.max(1, rect.width);
      vh = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(vw * dpr));
      canvas.height = Math.max(1, Math.floor(vh * dpr));
    };

    const drawAvatar = (avatar: AvatarState, side: ScoreOwner, color: string, flash: string) => {
      const z = side === "player" ? BASE_PLAYER : BASE_CPU;
      const base = project(avatar.x, z, 0);
      const scale = base.p;
      const bodyH = 84 * scale;
      const bodyW = 28 * scale;

      ctx.fillStyle = avatar.flash > 0 ? flash : color;
      ctx.beginPath();
      ctx.ellipse(base.x, base.y - bodyH * 0.6, bodyW * 0.6, bodyH * 0.75, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(8,20,35,0.5)";
      ctx.beginPath();
      ctx.ellipse(base.x, base.y + 3, bodyW * 0.85, bodyW * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();

      const progress = avatar.swing > 0 ? clamp(1 - avatar.swing / SWING_DUR, 0, 1) : 0;
      const anchorX = base.x + (side === "player" ? bodyW * 0.58 : -bodyW * 0.58);
      const anchorY = base.y - bodyH * 0.72;
      const baseAngle = side === "player" ? -2.2 : 0.95;
      const sweep = side === "player" ? 2.3 : -2.3;
      const angle = baseAngle + sweep * progress + avatar.roll * (side === "player" ? 0.45 : -0.45);

      const handle = 31 * scale;
      const head = 12 * scale;
      const rx = anchorX + Math.cos(angle) * handle;
      const ry = anchorY + Math.sin(angle) * handle;

      ctx.strokeStyle = "#dbeafe";
      ctx.lineWidth = Math.max(2, 2.1 * scale);
      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY);
      ctx.lineTo(rx, ry);
      ctx.stroke();

      ctx.strokeStyle = avatar.flash > 0 ? "#fde68a" : "#93c5fd";
      ctx.beginPath();
      ctx.ellipse(rx, ry, head, head * 1.26, angle, 0, Math.PI * 2);
      ctx.stroke();
    };

    const frame = (nowMs: number) => {
      const dt = Math.min((nowMs - lastFrame) / 1000, 0.033);
      lastFrame = nowMs;

      const state = gameRef.current;
      const control = controlRef.current;

      control.swing = Math.max(0, control.swing - dt * 1.25);

      if (control.pending && connectedRef.current && !state.winner && state.player.cooldown <= 0 && state.player.swing <= 0) {
        const event = control.pending;
        control.pending = null;
        startSwing(state.player, event.strength, event.roll, event.pitch);
      }

      const b = state.ball;
      const pLimit = HALF_X - 0.12;
      const cLimit = HALF_X - 0.16;

      if (state.lastHitter === null) {
        state.player.target = clamp(b.x * 0.8, -pLimit, pLimit);
        state.cpu.target = clamp(b.x * 0.8, -cLimit, cLimit);
      } else {
        state.player.target = b.vz > 0 || b.z > NET_Z ? clamp(b.x + b.vx * 0.14, -pLimit, pLimit) : clamp(b.x * 0.35, -0.45, 0.45);
        state.cpu.target = b.vz < 0 || b.z < NET_Z ? clamp(b.x + b.vx * 0.14, -cLimit, cLimit) : clamp(b.x * 0.35, -0.45, 0.45);
      }

      state.player.x = approach(state.player.x, state.player.target, PLAYER_SPEED * dt);
      state.cpu.x = approach(state.cpu.x, state.cpu.target, CPU_SPEED * dt);

      for (const avatar of [state.player, state.cpu]) {
        avatar.cooldown = Math.max(0, avatar.cooldown - dt);
        avatar.flash = Math.max(0, avatar.flash - dt);
        if (avatar.swing > 0) avatar.swing = Math.max(0, avatar.swing - dt);
      }

      let ended = false;
      if (!state.winner && connectedRef.current) {
        if (state.lastHitter === null) {
          state.serveDelay = Math.max(0, state.serveDelay - dt);
          const serverAvatar = state.server === "player" ? state.player : state.cpu;
          const z = state.server === "player" ? BASE_PLAYER : BASE_CPU;
          b.x += (serverAvatar.x - b.x) * 0.24;
          b.z = z;
          b.y = 1.03 + Math.sin(nowMs * 0.006) * 0.02;

          if (state.server === "player") {
            if (state.serveDelay <= 0 && state.player.swing > 0 && !state.player.used) {
              const progress = 1 - state.player.swing / SWING_DUR;
              if (progress > 0.2 && progress < 0.74) {
                strike(state, "player", state.player.power, state.player.roll, state.player.pitch, true);
                state.player.used = true;
                state.player.flash = 0.12;
                state.status = "Rally live";
              }
            }
          } else {
            if (state.serveDelay <= 0 && state.cpu.swing <= 0 && state.cpu.cooldown <= 0) {
              startSwing(state.cpu, 0.55 + Math.random() * 0.35, clamp((Math.random() - 0.5) * 0.9, -1, 1), clamp((Math.random() - 0.1) * 0.8, -1, 1));
            }
            if (state.cpu.swing > 0 && !state.cpu.used) {
              const progress = 1 - state.cpu.swing / SWING_DUR;
              if (progress > 0.24 && progress < 0.72) {
                strike(state, "cpu", state.cpu.power, state.cpu.roll, state.cpu.pitch, true);
                state.cpu.used = true;
                state.cpu.flash = 0.1;
              }
            }
          }
        } else {
          const prevZ = b.z;
          const prevY = b.y;

          b.vy -= GRAVITY * dt;
          b.vx *= 1 - AIR * dt;
          b.vz *= 1 - AIR * dt;
          b.x += b.vx * dt;
          b.z += b.vz * dt;
          b.y += b.vy * dt;

          if (b.vz < -0.1 && b.z < 0.38 && state.cpu.swing <= 0 && state.cpu.cooldown <= 0) {
            const bias = clamp(0.5 - Math.abs(b.x - state.cpu.x), 0, 0.5);
            startSwing(state.cpu, clamp(0.45 + bias + Math.random() * 0.25, 0.45, 0.95), clamp((b.x - state.cpu.x) * 1.6 + (Math.random() - 0.5) * 0.35, -1, 1), clamp((Math.random() - 0.2) * 0.8, -1, 1));
          }

          if (state.player.swing > 0 && !state.player.used && canPlayerHit(state)) {
            strike(state, "player", state.player.power, state.player.roll, state.player.pitch, false);
            state.player.used = true;
            state.player.flash = 0.12;
          }

          if (state.cpu.swing > 0 && !state.cpu.used && canCpuHit(state)) {
            strike(state, "cpu", state.cpu.power, state.cpu.roll, state.cpu.pitch, false);
            state.cpu.used = true;
            state.cpu.flash = 0.12;
          }

          if (state.lastHitter) {
            const crossed = (prevZ - NET_Z) * (b.z - NET_Z) <= 0 && Math.abs(b.z - prevZ) > 1e-6;
            if (crossed) {
              const t = (NET_Z - prevZ) / (b.z - prevZ);
              const yAtNet = prevY + (b.y - prevY) * t;
              if (yAtNet < NET_H - 0.02) {
                pointTo(opponent(state.lastHitter), "Into the net");
                ended = true;
              }
            }
          }

          if (!ended && b.y <= 0 && state.lastHitter) {
            b.y = 0;
            const inBounds = Math.abs(b.x) <= HALF_X && b.z >= 0 && b.z <= 1;
            const side: ScoreOwner = b.z >= NET_Z ? "player" : "cpu";

            if (!inBounds || side !== state.expectedBounce) {
              pointTo(opponent(state.lastHitter), "Shot out");
              ended = true;
            } else if (state.bounced) {
              pointTo(state.lastHitter, "Second bounce");
              ended = true;
            } else {
              state.bounced = true;
              b.vy = Math.max(Math.abs(b.vy) * BOUNCE, 1.05);
              b.vx *= 0.94;
              b.vz *= 0.96;
            }
          }

          if (!ended && state.lastHitter && (Math.abs(b.x) > HALF_X + 0.4 || b.z < -0.28 || b.z > 1.28)) {
            pointTo(opponent(state.lastHitter), "Ball sailed long");
            ended = true;
          }
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);

      const scale = Math.min(vw / VIEW_W, vh / VIEW_H);
      const ox = (vw - VIEW_W * scale) / 2;
      const oy = (vh - VIEW_H * scale) / 2;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);

      const bg = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      bg.addColorStop(0, "#0f2f4f");
      bg.addColorStop(1, "#062139");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);

      const farL = project(-HALF_X, 0, 0);
      const farR = project(HALF_X, 0, 0);
      const nearR = project(HALF_X, 1, 0);
      const nearL = project(-HALF_X, 1, 0);

      ctx.fillStyle = "#1f6b8d";
      ctx.beginPath();
      ctx.moveTo(farL.x, farL.y);
      ctx.lineTo(farR.x, farR.y);
      ctx.lineTo(nearR.x, nearR.y);
      ctx.lineTo(nearL.x, nearL.y);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = "rgba(228,244,255,0.8)";
      ctx.lineWidth = 2;
      ctx.stroke();

      const netL0 = project(-HALF_X * 1.02, NET_Z, 0);
      const netR0 = project(HALF_X * 1.02, NET_Z, 0);
      const netL1 = project(-HALF_X * 1.02, NET_Z, NET_H);
      const netR1 = project(HALF_X * 1.02, NET_Z, NET_H);
      ctx.beginPath();
      ctx.moveTo(netL0.x, netL0.y);
      ctx.lineTo(netR0.x, netR0.y);
      ctx.moveTo(netL1.x, netL1.y);
      ctx.lineTo(netR1.x, netR1.y);
      ctx.strokeStyle = "#f1f5f9";
      ctx.stroke();

      drawAvatar(state.cpu, "cpu", "#f97316", "#fdba74");
      drawAvatar(state.player, "player", "#10b981", "#6ee7b7");

      const s = project(b.x, b.z, 0);
      const p = project(b.x, b.z, b.y);
      const shadow = 13 * s.p + 4;
      const r = Math.max(5, b.radius * 420 * p.p);

      ctx.fillStyle = "rgba(0,15,35,0.28)";
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + 2, shadow, shadow * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(7,22,35,0.45)";
      ctx.fillRect(24, 18, 165, 52);
      ctx.fillRect(VIEW_W - 189, 18, 165, 52);
      ctx.fillStyle = "#f8fafc";
      ctx.font = '700 32px "Trebuchet MS", sans-serif';
      ctx.textAlign = "center";
      ctx.fillText(String(state.playerScore), 106, 54);
      ctx.fillText(String(state.cpuScore), VIEW_W - 106, 54);

      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(255,255,255,0.2)";
      ctx.fillRect(30, VIEW_H - 26, 176, 8);
      ctx.fillStyle = "#22d3ee";
      ctx.fillRect(30, VIEW_H - 26, 176 * clamp(control.swing, 0, 1), 8);

      if (!connectedRef.current) {
        ctx.fillStyle = "rgba(2,10,22,0.72)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        ctx.fillStyle = "#e2e8f0";
        ctx.textAlign = "center";
        ctx.font = '700 34px "Trebuchet MS", sans-serif';
        ctx.fillText("Connect phone controller", VIEW_W / 2, VIEW_H / 2 - 12);
        ctx.font = '500 18px "Trebuchet MS", sans-serif';
        ctx.fillStyle = "#94a3b8";
        ctx.fillText("Swing to hit. Roll the phone to aim.", VIEW_W / 2, VIEW_H / 2 + 22);
      } else if (state.winner) {
        ctx.fillStyle = "rgba(2,10,22,0.72)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        ctx.textAlign = "center";
        ctx.fillStyle = state.winner === "player" ? "#34d399" : "#fb7185";
        ctx.font = '700 42px "Trebuchet MS", sans-serif';
        ctx.fillText(state.winner === "player" ? "You win the match" : "CPU wins the match", VIEW_W / 2, VIEW_H / 2 - 6);
        ctx.fillStyle = "#cbd5e1";
        ctx.font = '500 18px "Trebuchet MS", sans-serif';
        ctx.fillText("Press Reset Match to replay", VIEW_W / 2, VIEW_H / 2 + 30);
      } else if (state.lastHitter === null && state.server === "player") {
        ctx.fillStyle = "rgba(2,10,22,0.46)";
        ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        ctx.textAlign = "center";
        ctx.fillStyle = "#e2e8f0";
        ctx.font = '700 30px "Trebuchet MS", sans-serif';
        ctx.fillText("Swing to serve", VIEW_W / 2, VIEW_H / 2 - 8);
        ctx.fillStyle = "#94a3b8";
        ctx.font = '500 17px "Trebuchet MS", sans-serif';
        ctx.fillText("Wii-style: timing + wrist angle shape the shot", VIEW_W / 2, VIEW_H / 2 + 22);
      }

      ctx.restore();

      if (nowMs - lastHud > 110) {
        lastHud = nowMs;
        syncHud();
      }

      raf = window.requestAnimationFrame(frame);
    };

    resize();
    syncHud();
    window.addEventListener("resize", resize);
    raf = window.requestAnimationFrame(frame);

    return () => {
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(raf);
    };
  }, [role]);

  const requestPermission = async () => {
    try {
      const motionCtor = (window as Window & { DeviceMotionEvent?: PermissionRequestCapable }).DeviceMotionEvent;
      const orientationCtor = (window as Window & { DeviceOrientationEvent?: PermissionRequestCapable }).DeviceOrientationEvent;
      const reqs: Array<Promise<"granted" | "denied">> = [];

      if (motionCtor?.requestPermission) reqs.push(motionCtor.requestPermission());
      if (orientationCtor?.requestPermission) reqs.push(orientationCtor.requestPermission());

      if (reqs.length === 0) {
        setPermission("granted");
        return;
      }

      const results = await Promise.all(reqs);
      setPermission(results.every((r) => r === "granted") ? "granted" : "denied");
    } catch {
      setPermission("denied");
    }
  };

  const copyPhoneLink = async () => {
    if (!phoneUrl) return;
    try {
      await navigator.clipboard.writeText(phoneUrl);
    } catch {
      // Ignore clipboard errors.
    }
  };

  const resetMatch = () => {
    gameRef.current = createGame();
    controlRef.current.pending = null;
    controlRef.current.swing = 0;
    setGameHud({ player: 0, cpu: 0, rally: 0, winner: null, status: "Swing your phone to serve" });
    setControlHud((prev) => ({ ...prev, swing: 0 }));
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/70">Pocket Racket</p>
          <h1 className="text-3xl font-semibold">Wii-Style Phone Tennis</h1>
          <p className="text-sm text-slate-300/85">
            The phone acts like a Wii Remote: swing to hit, wrist angle controls shot direction.
          </p>
        </header>

        <div className="grid gap-6 xl:grid-cols-[2fr,1fr]">
          <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm text-slate-400">Role: <span className="text-slate-100">{role === "host" ? "Host" : "Phone"}</span></p>
                <p className="text-sm text-slate-400">Session: <span className="text-slate-100">{session || "..."}</span></p>
              </div>
              {role === "host" && (
                <div className="flex items-center gap-2 rounded-full border border-slate-700/80 px-3 py-1 text-xs">
                  <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-slate-500"}`} />
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
                      <img src={qrDataUrl} alt="Session QR" className="h-full w-full rounded-lg bg-white p-2" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-slate-400">Generating QR...</div>
                    )}
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm">
                    <div className="rounded-lg bg-slate-800/70 p-2 break-all text-slate-200">{phoneUrl || "Preparing phone link..."}</div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={copyPhoneLink} disabled={!phoneUrl} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 enabled:hover:bg-slate-800 disabled:opacity-40">Copy Link</button>
                      <button onClick={() => window.open(phoneUrl, "_blank")} disabled={!phoneUrl} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 enabled:hover:bg-slate-800 disabled:opacity-40">Open Phone View</button>
                      <button onClick={resetMatch} className="rounded-lg border border-cyan-600/70 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/20">Reset Match</button>
                    </div>
                  </div>
                </div>

                <canvas ref={canvasRef} className="aspect-[16/9] w-full rounded-xl border border-slate-800 bg-slate-950" />

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
                    <p className="mt-1 text-sm text-slate-200">Roll {controlHud.roll.toFixed(2)} | Pitch {controlHud.pitch.toFixed(2)}</p>
                    <p className="text-xs text-slate-400">Swing {controlHud.swing.toFixed(2)}</p>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-sm text-slate-300">{gameHud.status}</div>

                {gameHud.winner && (
                  <div className={`rounded-xl border p-3 text-sm ${gameHud.winner === "player" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : "border-rose-500/40 bg-rose-500/10 text-rose-200"}`}>
                    {gameHud.winner === "player" ? "Match won. Wii-style timing looks good." : "CPU won this match. Try faster forward swings."}
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-4 space-y-4 text-sm text-slate-200">
                <p>Hold phone like a Wii Remote. Keep this page open while you swing to control your racket.</p>

                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <div className="flex items-center justify-between">
                    <span>Sensor permission</span>
                    <span className="text-xs text-slate-400">{permission}</span>
                  </div>
                  <button onClick={requestPermission} className="mt-3 w-full rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800">Enable Motion Access</button>
                  {!sensorAvailable && <p className="mt-3 text-xs text-rose-300">This browser/device does not expose motion sensors.</p>}
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Live telemetry</p>
                  <p className="mt-2 text-sm text-slate-300">Roll {phoneTelemetry.roll.toFixed(2)} | Pitch {phoneTelemetry.pitch.toFixed(2)}</p>
                  <p className="mt-1 text-sm text-slate-300">Swing {phoneTelemetry.swing.toFixed(2)}</p>
                  <p className="mt-1 text-xs text-slate-400">Packets sent: {phoneTelemetry.packets}</p>
                  <div className="mt-3 h-2 overflow-hidden rounded bg-slate-800">
                    <div className="h-full bg-cyan-400 transition-all" style={{ width: `${clamp(phoneTelemetry.swing, 0, 1) * 100}%` }} />
                  </div>
                </div>

                <p className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-400">Fast forward swing = power. Wrist roll adds cross-court direction.</p>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-6">
            <h2 className="text-lg font-semibold">Wii-Style Flow</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm text-slate-300">
              <li>Run the host view on your PC.</li>
              <li>Scan the QR code on your phone.</li>
              <li>Enable motion sensors on phone.</li>
              <li>Swing the phone to serve and return shots.</li>
            </ol>
            <p className="mt-4 text-xs text-slate-500">No manual player movement needed. Timing + swing angle drive your shots, similar to Wii Sports tennis.</p>
          </section>
        </div>
      </div>
    </main>
  );
}
