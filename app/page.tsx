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

type SwingPacket = {
  strength: number;
  roll: number;
  pitch: number;
  at: number;
};

type ControlState = {
  roll: number;
  pitch: number;
  swingMeter: number;
  pendingSwing: SwingPacket | null;
  lastSwingAt: number;
  lastSeq: number;
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
  status: string;
};

type SimState = {
  ballPos: THREE.Vector3;
  ballVel: THREE.Vector3;
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

const COURT_HALF_WIDTH = 4;
const COURT_HALF_LENGTH = 8;
const BASELINE_PLAYER_Z = 6.3;
const BASELINE_CPU_Z = -6.3;
const NET_Z = 0;
const NET_HEIGHT = 1.1;

const BALL_RADIUS = 0.18;
const GRAVITY = 24;
const GROUND_BOUNCE = 0.62;
const AIR_DRAG = 0.04;

const PLAYER_SPEED = 7.2;
const CPU_SPEED = 6.4;
const RACKET_REACH_X = 0.95;
const HIT_Y_MIN = 0.35;
const HIT_Y_MAX = 2.9;

const SWING_DURATION = 0.32;
const SWING_COOLDOWN = 0.16;
const SWING_TRIGGER = 0.5;
const SWING_REARM_MS = 250;

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
  const gravity = sample?.accelerationIncludingGravity;

  const alpha = rate?.alpha ?? 0;
  const beta = rate?.beta ?? 0;
  const gamma = rate?.gamma ?? 0;
  const gyroMagnitude = Math.sqrt(alpha ** 2 + beta ** 2 + gamma ** 2);
  const gyroSwing = clamp((gyroMagnitude - 62) / 315, 0, 1);

  const gx = gravity?.x ?? 0;
  const gy = gravity?.y ?? 0;
  const gz = gravity?.z ?? 0;
  const gravityMagnitude = Math.sqrt(gx ** 2 + gy ** 2 + gz ** 2);
  const accelSwing = clamp((Math.abs(gravityMagnitude - 9.8) - 1) / 9, 0, 1);

  return Math.max(gyroSwing, accelSwing);
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
}

function createSimState(): SimState {
  const sim: SimState = {
    ballPos: new THREE.Vector3(0, 1.45, BASELINE_PLAYER_Z),
    ballVel: new THREE.Vector3(0, 0, 0),
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
  const forward = (isServe ? 11 : 12) + power * 6;
  const toward = hitter === "player" ? -1 : 1;
  const lateral = clamp(roll * 7 + (hitter === "cpu" ? (Math.random() - 0.5) * 1.8 : 0), -9, 9);
  const lift = (isServe ? 8.2 : 7.2) + power * 3 + clamp(-pitch * 2.1, -1.2, 2);

  sim.ballVel.set(lateral, lift, toward * forward);

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
  sim.match.rally = Math.max(1, sim.match.rally + 1);
}

function canPlayerHit(sim: SimState) {
  const ball = sim.ballPos;
  return (
    sim.ballVel.z > 0 &&
    ball.z > 2.2 &&
    ball.z < COURT_HALF_LENGTH &&
    Math.abs(ball.x - sim.player.x) <= RACKET_REACH_X &&
    ball.y >= HIT_Y_MIN &&
    ball.y <= HIT_Y_MAX
  );
}

function canCpuHit(sim: SimState) {
  const ball = sim.ballPos;
  return (
    sim.ballVel.z < 0 &&
    ball.z < -2.2 &&
    ball.z > -COURT_HALF_LENGTH &&
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

  const latestRef = useRef<MotionSample | null>(null);
  const sendingRef = useRef(false);
  const packetsRef = useRef(0);
  const controlRef = useRef<ControlState>({
    roll: 0,
    pitch: 0,
    swingMeter: 0,
    pendingSwing: null,
    lastSwingAt: 0,
    lastSeq: -1,
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

    const roll = getRoll(latest.sample);
    const pitch = getPitch(latest.sample);
    const swing = getSwing(latest.sample);

    if (roll !== null) {
      control.roll = roll;
    }
    if (pitch !== null) {
      control.pitch = pitch;
    }

    control.swingMeter = Math.max(control.swingMeter * 0.58, swing);
    if (swing > SWING_TRIGGER && latest.t - control.lastSwingAt > SWING_REARM_MS) {
      control.pendingSwing = {
        strength: clamp(swing * 1.18, 0.2, 1),
        roll: control.roll,
        pitch: control.pitch,
        at: latest.t,
      };
      control.lastSwingAt = latest.t;
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
      swingMeter: 0,
      pendingSwing: null,
      lastSwingAt: 0,
      lastSeq: -1,
    };
    setGameHud({
      player: 0,
      cpu: 0,
      rally: 0,
      winner: null,
      status: "Swing your phone to serve",
    });
    setControlHud({ roll: 0, pitch: 0, swing: 0 });
  }, [role]);

  useEffect(() => {
    if (role !== "host") return;
    if (!renderMountRef.current) return;

    const mount = renderMountRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0c2138");
    scene.fog = new THREE.Fog(0x0c2138, 18, 34);

    const camera = new THREE.PerspectiveCamera(
      52,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.1,
      80,
    );
    camera.position.set(0, 7.4, 13.2);
    camera.lookAt(0, 1.4, -0.8);

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
    dir.shadow.camera.far = 32;
    dir.shadow.camera.left = -12;
    dir.shadow.camera.right = 12;
    dir.shadow.camera.top = 12;
    dir.shadow.camera.bottom = -12;
    scene.add(dir);

    const arena = new THREE.Mesh(
      new THREE.PlaneGeometry(38, 34),
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
    addLine(-COURT_HALF_WIDTH, -2.2, COURT_HALF_WIDTH, -2.2);
    addLine(-COURT_HALF_WIDTH, 2.2, COURT_HALF_WIDTH, 2.2);
    addLine(0, -2.2, 0, 2.2);
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

    const cpuVisual = createAvatarVisual("cpu");
    cpuVisual.group.position.set(0, 0, BASELINE_CPU_Z);
    cpuVisual.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
      }
    });
    scene.add(cpuVisual.group);

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
            ? clamp(sim.ballPos.x + sim.ballVel.x * 0.08, -playerLimit, playerLimit)
            : clamp(sim.ballPos.x * 0.35, -1.2, 1.2);

        sim.cpu.targetX =
          sim.ballVel.z < 0 || sim.ballPos.z < NET_Z
            ? clamp(sim.ballPos.x + sim.ballVel.x * 0.08, -cpuLimit, cpuLimit)
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
          sim.ballPos.y = 1.45 + Math.sin(now * 0.006) * 0.06;

          if (match.server === "player") {
            if (match.serveTimer <= 0 && sim.player.swingT > 0 && !sim.player.used) {
              const progress = 1 - sim.player.swingT / SWING_DURATION;
              if (progress > 0.2 && progress < 0.76) {
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
              if (progress > 0.26 && progress < 0.74) {
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
          sim.ballPos.addScaledVector(sim.ballVel, dt);

          if (
            sim.ballVel.z < -0.45 &&
            sim.ballPos.z < -2.1 &&
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
              if (yAtNet < NET_HEIGHT) {
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
              match.bounced = true;
              sim.ballVel.y = Math.max(Math.abs(sim.ballVel.y) * GROUND_BOUNCE, 4.4);
              sim.ballVel.x *= 0.93;
              sim.ballVel.z *= 0.95;
            }
          }

          if (
            !pointEnded &&
            match.lastHitter &&
            (Math.abs(sim.ballPos.x) > COURT_HALF_WIDTH + 2 ||
              sim.ballPos.z < -COURT_HALF_LENGTH - 4 ||
              sim.ballPos.z > COURT_HALF_LENGTH + 4)
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

      camera.position.x = THREE.MathUtils.lerp(camera.position.x, sim.ballPos.x * 0.16, 0.05);
      camera.lookAt(sim.ballPos.x * 0.1, 1.3, -0.8);

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
    setGameHud({
      player: 0,
      cpu: 0,
      rally: 0,
      winner: null,
      status: "Swing your phone to serve",
    });
    setControlHud((prev) => ({ ...prev, swing: 0 }));
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/70">Pocket Racket</p>
          <h1 className="text-3xl font-semibold">3D Wii-Style Phone Tennis</h1>
          <p className="text-sm text-slate-300/85">
            Real 3D court, Wii-like swing timing, and phone wrist angle for shot direction.
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

                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-sm text-slate-300">
                  {gameHud.status}
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
                  Forward acceleration sets power. Wrist roll creates cross-court shots.
                </p>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-6">
            <h2 className="text-lg font-semibold">3D Wii-Style Flow</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm text-slate-300">
              <li>Run host on PC and scan the QR code with your phone.</li>
              <li>Enable motion sensors on phone.</li>
              <li>Swing to serve, then keep timing your swings for returns.</li>
              <li>Roll/pitch your wrist during swing to shape shot direction and lift.</li>
            </ol>
            <p className="mt-4 text-xs text-slate-500">
              This is now true 3D rendering and physics (Three.js), not a flat 2D paddle board.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
