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

type BallState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
};

type PaddleState = {
  x: number;
  width: number;
  flashUntil: number;
};

type GameState = {
  ball: BallState;
  player: PaddleState;
  cpu: PaddleState;
  playerScore: number;
  cpuScore: number;
  rally: number;
  winner: ScoreOwner | null;
  serveCooldown: number;
};

type PermissionRequestCapable = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

const GAME_WIDTH = 960;
const GAME_HEIGHT = 540;
const SIDE_PADDING = 30;
const PLAYER_Y = GAME_HEIGHT - 46;
const CPU_Y = 46;
const PADDLE_HEIGHT = 16;
const PADDLE_WIDTH = 142;
const BALL_RADIUS = 9;
const START_SPEED = 360;
const MIN_BALL_SPEED = 280;
const MAX_BALL_SPEED = 920;
const PLAYER_SPEED = 1250;
const CPU_BASE_SPEED = 430;
const SWING_DECAY = 1.2;
const WIN_SCORE = 7;
const SERVE_DELAY_S = 0.85;
const CONNECTION_TIMEOUT_MS = 1200;

function makeSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

function getTiltFromSample(sample: MotionSample | null): number | null {
  const orientation = sample?.orientation;
  if (!orientation) return null;

  const source =
    typeof orientation.gamma === "number" ? orientation.gamma : orientation.beta;
  if (typeof source !== "number") return null;

  return clamp(source / 45, -1, 1);
}

function getSwingFromSample(sample: MotionSample | null): number {
  const rate = sample?.rotationRate;
  const gravity = sample?.accelerationIncludingGravity;

  const alpha = rate?.alpha ?? 0;
  const beta = rate?.beta ?? 0;
  const gamma = rate?.gamma ?? 0;

  const gyroMagnitude = Math.sqrt(alpha ** 2 + beta ** 2 + gamma ** 2);
  const gyroSwing = clamp((gyroMagnitude - 55) / 300, 0, 1);

  const gx = gravity?.x ?? 0;
  const gy = gravity?.y ?? 0;
  const gz = gravity?.z ?? 0;
  const gravityMagnitude = Math.sqrt(gx ** 2 + gy ** 2 + gz ** 2);
  const accelSwing = clamp((Math.abs(gravityMagnitude - 9.8) - 0.9) / 8.5, 0, 1);

  return Math.max(gyroSwing, accelSwing);
}

function createServeBall(direction: 1 | -1): BallState {
  const angle = (Math.random() - 0.5) * 0.8;
  return {
    x: GAME_WIDTH / 2,
    y: GAME_HEIGHT / 2,
    vx: START_SPEED * Math.sin(angle),
    vy: START_SPEED * Math.cos(angle) * direction,
    radius: BALL_RADIUS,
  };
}

function createInitialGameState(): GameState {
  return {
    ball: createServeBall(-1),
    player: { x: GAME_WIDTH / 2, width: PADDLE_WIDTH, flashUntil: 0 },
    cpu: { x: GAME_WIDTH / 2, width: PADDLE_WIDTH, flashUntil: 0 },
    playerScore: 0,
    cpuScore: 0,
    rally: 0,
    winner: null,
    serveCooldown: SERVE_DELAY_S,
  };
}

export default function Home() {
  const [role, setRole] = useState<"host" | "phone">("host");
  const [session, setSession] = useState<string>("");
  const [phoneUrl, setPhoneUrl] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [latest, setLatest] = useState<StoreEntry | null>(null);
  const [permission, setPermission] = useState<PermissionState>("unknown");
  const [sensorAvailable, setSensorAvailable] = useState(true);
  const [clock, setClock] = useState(() => Date.now());
  const [phoneTelemetry, setPhoneTelemetry] = useState({
    tilt: 0,
    swing: 0,
    packets: 0,
  });
  const [gameHud, setGameHud] = useState<{
    playerScore: number;
    cpuScore: number;
    rally: number;
    winner: ScoreOwner | null;
  }>({
    playerScore: 0,
    cpuScore: 0,
    rally: 0,
    winner: null,
  });
  const [controlHud, setControlHud] = useState({ tilt: 0, swing: 0 });

  const latestRef = useRef<MotionSample | null>(null);
  const sendingRef = useRef(false);
  const packetsRef = useRef(0);
  const controlRef = useRef({ tilt: 0, swing: 0, lastUpdated: 0 });
  const connectedRef = useRef(false);
  const gameRef = useRef<GameState>(createInitialGameState());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roleParam = params.get("role");
    const sessionParam = params.get("session");

    if (roleParam === "phone") {
      setRole("phone");
    }

    if (sessionParam) {
      setSession(sessionParam);
    } else {
      setSession(makeSessionId());
    }
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
      .then((dataUrl) => setQrDataUrl(dataUrl))
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
        if (!mounted) return;
        if (data?.entry) {
          setLatest(data.entry as StoreEntry);
        }
      } catch {
        // Ignore transient polling errors.
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

    const tilt = getTiltFromSample(latest.sample);
    if (tilt !== null) {
      controlRef.current.tilt = tilt;
    }

    const swing = getSwingFromSample(latest.sample);
    controlRef.current.swing = Math.max(controlRef.current.swing * 0.7, swing);
    controlRef.current.lastUpdated = latest.t;
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
    setPhoneTelemetry({ tilt: 0, swing: 0, packets: 0 });

    let mounted = true;
    let lastPreview = 0;

    const publishPreview = () => {
      const now = performance.now();
      if (now - lastPreview < 100) return;
      lastPreview = now;

      const sample = latestRef.current;
      const tilt = getTiltFromSample(sample);
      const swing = getSwingFromSample(sample);

      setPhoneTelemetry((prev) => ({
        ...prev,
        tilt: tilt ?? prev.tilt,
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
          body: JSON.stringify({
            session,
            sample: latestRef.current,
          }),
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

    gameRef.current = createInitialGameState();
    setGameHud({ playerScore: 0, cpuScore: 0, rally: 0, winner: null });
    setControlHud({ tilt: 0, swing: 0 });
    controlRef.current = { tilt: 0, swing: 0, lastUpdated: 0 };
  }, [role]);

  useEffect(() => {
    if (role !== "host") return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastFrame = performance.now();
    let lastHudCommit = 0;
    let dpr = 1;
    let viewWidth = 1;
    let viewHeight = 1;

    const syncHud = () => {
      const state = gameRef.current;
      setGameHud({
        playerScore: state.playerScore,
        cpuScore: state.cpuScore,
        rally: state.rally,
        winner: state.winner,
      });
      setControlHud({
        tilt: controlRef.current.tilt,
        swing: controlRef.current.swing,
      });
    };

    const scorePoint = (scorer: ScoreOwner) => {
      const state = gameRef.current;

      if (scorer === "player") {
        state.playerScore += 1;
      } else {
        state.cpuScore += 1;
      }

      state.rally = 0;

      if (state.playerScore >= WIN_SCORE || state.cpuScore >= WIN_SCORE) {
        state.winner = state.playerScore > state.cpuScore ? "player" : "cpu";
        state.ball.x = GAME_WIDTH / 2;
        state.ball.y = GAME_HEIGHT / 2;
        state.ball.vx = 0;
        state.ball.vy = 0;
        state.serveCooldown = 0;
        syncHud();
        return;
      }

      const direction: 1 | -1 = scorer === "player" ? -1 : 1;
      state.ball = createServeBall(direction);
      state.serveCooldown = SERVE_DELAY_S;
      syncHud();
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      viewWidth = Math.max(1, rect.width);
      viewHeight = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(viewWidth * dpr));
      canvas.height = Math.max(1, Math.floor(viewHeight * dpr));
    };

    const drawPaddle = (
      paddle: PaddleState,
      y: number,
      activeColor: string,
      idleColor: string,
      now: number,
    ) => {
      const isHot = now < paddle.flashUntil;
      ctx.fillStyle = isHot ? activeColor : idleColor;
      ctx.fillRect(
        paddle.x - paddle.width / 2,
        y - PADDLE_HEIGHT / 2,
        paddle.width,
        PADDLE_HEIGHT,
      );
    };

    const frame = (now: number) => {
      const dt = Math.min((now - lastFrame) / 1000, 0.033);
      lastFrame = now;

      const state = gameRef.current;
      const controls = controlRef.current;

      controls.swing = Math.max(0, controls.swing - dt * SWING_DECAY);

      const horizontalPadding = SIDE_PADDING + state.player.width / 2;
      const targetX =
        GAME_WIDTH / 2 +
        controls.tilt * (GAME_WIDTH / 2 - SIDE_PADDING - state.player.width / 2);
      state.player.x += clamp(
        targetX - state.player.x,
        -PLAYER_SPEED * dt,
        PLAYER_SPEED * dt,
      );
      state.player.x = clamp(state.player.x, horizontalPadding, GAME_WIDTH - horizontalPadding);

      const cpuTarget = state.ball.x + clamp(state.ball.vx * 0.05, -70, 70);
      const cpuSpeed = CPU_BASE_SPEED + Math.min(state.rally * 12, 260);
      state.cpu.x += clamp(cpuTarget - state.cpu.x, -cpuSpeed * dt, cpuSpeed * dt);
      state.cpu.x = clamp(state.cpu.x, horizontalPadding, GAME_WIDTH - horizontalPadding);

      if (!state.winner && connectedRef.current) {
        state.serveCooldown = Math.max(0, state.serveCooldown - dt);

        if (state.serveCooldown <= 0) {
          const ball = state.ball;
          ball.x += ball.vx * dt;
          ball.y += ball.vy * dt;

          if (ball.x - ball.radius < SIDE_PADDING) {
            ball.x = SIDE_PADDING + ball.radius;
            ball.vx = Math.abs(ball.vx);
          } else if (ball.x + ball.radius > GAME_WIDTH - SIDE_PADDING) {
            ball.x = GAME_WIDTH - SIDE_PADDING - ball.radius;
            ball.vx = -Math.abs(ball.vx);
          }

          const playerTop = PLAYER_Y - PADDLE_HEIGHT / 2;
          const playerBottom = PLAYER_Y + PADDLE_HEIGHT / 2;
          if (
            ball.vy > 0 &&
            ball.y + ball.radius >= playerTop &&
            ball.y - ball.radius <= playerBottom &&
            Math.abs(ball.x - state.player.x) <= state.player.width / 2 + ball.radius
          ) {
            const hitOffset = clamp(
              (ball.x - state.player.x) / (state.player.width / 2),
              -1,
              1,
            );
            const speed = clamp(
              Math.hypot(ball.vx, ball.vy) * (1.03 + controls.swing * 0.32),
              MIN_BALL_SPEED,
              MAX_BALL_SPEED,
            );
            const angle = hitOffset * 0.95;
            ball.vx = clamp(
              speed * Math.sin(angle) + controls.tilt * 120,
              -MAX_BALL_SPEED,
              MAX_BALL_SPEED,
            );
            ball.vy = -Math.abs(speed * Math.cos(angle));
            ball.y = playerTop - ball.radius;
            state.player.flashUntil = now + 120;
            state.rally += 1;
            controls.swing *= 0.35;
          }

          const cpuTop = CPU_Y - PADDLE_HEIGHT / 2;
          const cpuBottom = CPU_Y + PADDLE_HEIGHT / 2;
          if (
            ball.vy < 0 &&
            ball.y - ball.radius <= cpuBottom &&
            ball.y + ball.radius >= cpuTop &&
            Math.abs(ball.x - state.cpu.x) <= state.cpu.width / 2 + ball.radius
          ) {
            const hitOffset = clamp(
              (ball.x - state.cpu.x) / (state.cpu.width / 2),
              -1,
              1,
            );
            const speed = clamp(
              Math.hypot(ball.vx, ball.vy) * 1.02,
              MIN_BALL_SPEED,
              MAX_BALL_SPEED,
            );
            const angle = hitOffset * 0.8;
            ball.vx = speed * Math.sin(angle);
            ball.vy = Math.abs(speed * Math.cos(angle));
            ball.y = cpuBottom + ball.radius;
            state.cpu.flashUntil = now + 90;
            state.rally += 1;
          }

          if (ball.y + ball.radius > GAME_HEIGHT) {
            scorePoint("cpu");
          } else if (ball.y - ball.radius < 0) {
            scorePoint("player");
          }
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, viewWidth, viewHeight);

      const scale = Math.min(viewWidth / GAME_WIDTH, viewHeight / GAME_HEIGHT);
      const offsetX = (viewWidth - GAME_WIDTH * scale) / 2;
      const offsetY = (viewHeight - GAME_HEIGHT * scale) / 2;

      ctx.save();
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      const bg = ctx.createLinearGradient(0, 0, 0, GAME_HEIGHT);
      bg.addColorStop(0, "#07192f");
      bg.addColorStop(1, "#04101f");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

      ctx.strokeStyle = "rgba(194, 214, 243, 0.2)";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        SIDE_PADDING,
        SIDE_PADDING,
        GAME_WIDTH - SIDE_PADDING * 2,
        GAME_HEIGHT - SIDE_PADDING * 2,
      );

      ctx.setLineDash([14, 10]);
      ctx.beginPath();
      ctx.moveTo(SIDE_PADDING, GAME_HEIGHT / 2);
      ctx.lineTo(GAME_WIDTH - SIDE_PADDING, GAME_HEIGHT / 2);
      ctx.strokeStyle = "rgba(187, 224, 255, 0.35)";
      ctx.stroke();
      ctx.setLineDash([]);

      drawPaddle(state.cpu, CPU_Y, "#f97316", "#fb923c", now);
      drawPaddle(state.player, PLAYER_Y, "#34d399", "#10b981", now);

      ctx.fillStyle = "rgba(248, 250, 252, 0.22)";
      ctx.beginPath();
      ctx.arc(state.ball.x, state.ball.y, state.ball.radius + 8, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#f8fafc";
      ctx.beginPath();
      ctx.arc(state.ball.x, state.ball.y, state.ball.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
      ctx.fillRect(SIDE_PADDING, GAME_HEIGHT - 22, 150, 8);
      ctx.fillStyle = "#22d3ee";
      ctx.fillRect(SIDE_PADDING, GAME_HEIGHT - 22, 150 * controls.swing, 8);

      if (!connectedRef.current) {
        ctx.fillStyle = "rgba(2, 6, 23, 0.72)";
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        ctx.textAlign = "center";
        ctx.fillStyle = "#e2e8f0";
        ctx.font = '600 32px "Trebuchet MS", sans-serif';
        ctx.fillText("Connect your phone to start", GAME_WIDTH / 2, GAME_HEIGHT / 2 - 8);
        ctx.fillStyle = "#94a3b8";
        ctx.font = '500 18px "Trebuchet MS", sans-serif';
        ctx.fillText("Tilt to move. Swing to add power.", GAME_WIDTH / 2, GAME_HEIGHT / 2 + 24);
      } else if (state.winner) {
        ctx.fillStyle = "rgba(2, 6, 23, 0.72)";
        ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        ctx.textAlign = "center";
        ctx.fillStyle = state.winner === "player" ? "#34d399" : "#fb7185";
        ctx.font = '700 40px "Trebuchet MS", sans-serif';
        ctx.fillText(
          state.winner === "player" ? "You win the set" : "CPU wins the set",
          GAME_WIDTH / 2,
          GAME_HEIGHT / 2 - 4,
        );
        ctx.fillStyle = "#cbd5e1";
        ctx.font = '500 18px "Trebuchet MS", sans-serif';
        ctx.fillText("Press Reset Match to play again", GAME_WIDTH / 2, GAME_HEIGHT / 2 + 30);
      }

      ctx.restore();

      if (now - lastHudCommit > 120) {
        lastHudCommit = now;
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
      const granted = results.every((result) => result === "granted");
      setPermission(granted ? "granted" : "denied");
    } catch {
      setPermission("denied");
    }
  };

  const copyPhoneLink = async () => {
    if (!phoneUrl) return;
    try {
      await navigator.clipboard.writeText(phoneUrl);
    } catch {
      // Clipboard can fail on non-secure origins.
    }
  };

  const resetMatch = () => {
    gameRef.current = createInitialGameState();
    controlRef.current.swing = 0;
    setGameHud({ playerScore: 0, cpuScore: 0, rally: 0, winner: null });
    setControlHud((prev) => ({ ...prev, swing: 0 }));
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/70">
            Pocket Racket
          </p>
          <h1 className="text-3xl font-semibold">Phone Tennis Arena</h1>
          <p className="text-sm text-slate-300/85">
            Your phone is the racket: tilt to move, swing to smash.
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
                        onClick={resetMatch}
                        className="rounded-lg border border-cyan-600/70 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/20"
                      >
                        Reset Match
                      </button>
                    </div>
                  </div>
                </div>

                <canvas
                  ref={canvasRef}
                  className="aspect-[16/9] w-full rounded-xl border border-slate-800 bg-slate-950"
                />

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">You</p>
                    <p className="mt-1 text-2xl font-semibold text-emerald-300">
                      {gameHud.playerScore}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">CPU</p>
                    <p className="mt-1 text-2xl font-semibold text-orange-300">{gameHud.cpuScore}</p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Rally</p>
                    <p className="mt-1 text-2xl font-semibold text-slate-100">{gameHud.rally}</p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                    <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Control</p>
                    <p className="mt-1 text-sm text-slate-200">
                      Tilt {controlHud.tilt.toFixed(2)} | Swing {controlHud.swing.toFixed(2)}
                    </p>
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
                      ? "Set won. Nice control."
                      : "CPU took the set. Try stronger swings."}
                  </div>
                )}
              </div>
            ) : (
              <div className="mt-4 space-y-4 text-sm text-slate-200">
                <p>
                  Keep this page open. The host listens to this session and turns your phone movement into the racket.
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
                    Tilt {phoneTelemetry.tilt.toFixed(2)} | Swing {phoneTelemetry.swing.toFixed(2)}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">Packets sent: {phoneTelemetry.packets}</p>
                  <div className="mt-3 h-2 overflow-hidden rounded bg-slate-800">
                    <div
                      className="h-full bg-cyan-400 transition-all"
                      style={{ width: `${clamp(phoneTelemetry.swing, 0, 1) * 100}%` }}
                    />
                  </div>
                </div>

                <p className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-400">
                  Strong wrist rotation creates extra power on your next return.
                </p>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-6">
            <h2 className="text-lg font-semibold">Quick Setup</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm text-slate-300">
              <li>Start the dev server on the PC host.</li>
              <li>Scan the QR code with your phone.</li>
              <li>On phone, tap <span className="text-slate-100">Enable Motion Access</span>.</li>
              <li>Hold phone upright and tilt to track the ball.</li>
            </ol>
            <p className="mt-4 text-xs text-slate-500">
              If motion does not stream, use HTTPS on local network. Some mobile browsers block sensors on plain HTTP.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
