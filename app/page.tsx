"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import * as THREE from "three";

type InputPacket = {
  x: number; // 0.0 to 1.0 (normalized screen width)
  y: number; // 0.0 to 1.0 (normalized screen height)
  vx: number; // Velocity X
  vy: number; // Velocity Y
  swing: boolean; // Swing trigger
};

type StoreEntry = {
  t: number;
  seq: number;
  packet: InputPacket | null;
};

type PermissionState = "unknown" | "granted" | "denied";
type ScoreOwner = "player" | "cpu";
type HostPhase = "calibration" | "game";
type InputSource = "pc" | "phone" | null;

type SwingPacket = {
  strength: number;
  roll: number;
  pitch: number;
  at: number;
};

type SwingAxis = "alpha" | "beta" | "gamma";

type ControlState = {
  targetX: number;
  targetY: number;
  pendingSwing: SwingPacket | null;
  lastSwingTime: number;
  
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

type AvatarVisual = {
  group: THREE.Group;
  swingPivot: THREE.Object3D;
  bodyMaterial: THREE.MeshStandardMaterial;
  racketMaterial: THREE.MeshStandardMaterial;
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
const AIR_DRAG = 0.005;

const PLAYER_SPEED = 8.3;
const CPU_SPEED = 7.4;
const RACKET_REACH_X = 1.05;
const HIT_Y_MIN = 0.35;
const HIT_Y_MAX = 2.8;
const SWING_DURATION = 0.32;
const SWING_COOLDOWN = 0.16;
const SWING_REARM_MS = 250;
const POSITION_SMOOTHING = 0.15;

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

function updateControlFromPacket(
  control: ControlState,
  packet: InputPacket | null,
  sampleTime: number,
) {
  if (!packet) return;

  // Smooth position
  // Map X (0..1) to (-1..1) range for tracking logic
  const targetX = (packet.x - 0.5) * 2;
  const targetY = (packet.y - 0.5) * 2;

  control.targetX =
    control.targetX + (targetX - control.targetX) * POSITION_SMOOTHING;
  control.targetY =
    control.targetY + (targetY - control.targetY) * POSITION_SMOOTHING;

  // Detect Swing
  if (packet.swing && sampleTime - control.lastSwingTime > SWING_REARM_MS) {
    control.lastSwingTime = sampleTime;
    // Map vertical movement to pitch, horizontal speed to strength
    const velocityMag = Math.sqrt(packet.vx ** 2 + packet.vy ** 2);
    
    control.pendingSwing = {
      strength: clamp(velocityMag / 15, 0.4, 1.0),
      roll: -control.targetX * 0.5, // Wrist roll based on position (simple mechanic)
      pitch: -control.targetY * 0.8, // Pitch based on height of object
      at: sampleTime,
    };
  }
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

function resetSimState(sim: SimState) {
  const fresh = createSimState();
  sim.ballPos.copy(fresh.ballPos);
  sim.ballVel.copy(fresh.ballVel);
  sim.ballSpinSide = fresh.ballSpinSide;
  sim.ballSpinTop = fresh.ballSpinTop;
  sim.player = fresh.player;
  sim.cpu = fresh.cpu;
  sim.match = fresh.match;
}

function startSwing(avatar: AvatarSim, strength: number, roll: number, pitch: number) {
  avatar.swingT = SWING_DURATION;
  avatar.power = clamp(strength, 0.18, 0.86);
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
  const effectivePower = power * (isServe ? 0.86 : 0.8);
  const forward = (isServe ? 9.9 : 10.5) + effectivePower * (isServe ? 2.8 : 3.1);
  const toward = hitter === "player" ? -1 : 1;
  const lateral = clamp(
    roll * 3.7 + (hitter === "cpu" ? (Math.random() - 0.5) * 0.9 : 0),
    -5.4,
    5.4,
  );
  const lift =
    (isServe ? 4.2 : 3.8) +
    effectivePower * (isServe ? 1.4 : 1.25) +
    clamp(-pitch * 1.05, -0.75, 1.05);

  sim.ballVel.set(lateral, lift, toward * forward);
  sim.ballSpinSide = roll * (2.2 + effectivePower * 2.5);
  sim.ballSpinTop = clamp(-pitch * 2.9 + effectivePower * 1.1, -4.3, 5.1);

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

// --- CAMERA TRACKING HELPER ---
type RgbColor = { r: number; g: number; b: number };

function CameraController({
  onPacket,
}: {
  onPacket: (p: InputPacket) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [trackingColor, setTrackingColor] = useState<RgbColor | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const lastPos = useRef({ x: 0.5, y: 0.5 });
  const velocity = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let active = true;
    navigator.mediaDevices
      .getUserMedia({ video: { width: 320, height: 240, facingMode: "environment" }, audio: false })
      .then((s) => {
        if (active) {
          setStream(s);
          if (videoRef.current) {
            videoRef.current.srcObject = s;
            videoRef.current.play().catch(() => {});
          }
        }
      })
      .catch((e) => console.error("Camera denied", e));

    return () => {
      active = false;
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (!trackingColor) return;
    let raf = 0;

    const process = () => {
      if (!videoRef.current || !canvasRef.current) return;
      const vid = videoRef.current;
      const ctx = canvasRef.current.getContext("2d");
      if (!ctx || vid.readyState < 2) {
        raf = requestAnimationFrame(process);
        return;
      }

      // Draw small frame for processing
      ctx.drawImage(vid, 0, 0, 64, 48);
      const frame = ctx.getImageData(0, 0, 64, 48);
      const data = frame.data;
      let sumX = 0;
      let sumY = 0;
      let count = 0;

      // Simple color threshold
      const threshold = 60; 
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // Euclidean dist
        const dist = Math.sqrt(
          (r - trackingColor.r) ** 2 + (g - trackingColor.g) ** 2 + (b - trackingColor.b) ** 2
        );

        if (dist < threshold) {
          const pixelIdx = i / 4;
          const x = pixelIdx % 64;
          const y = Math.floor(pixelIdx / 64);
          sumX += x;
          sumY += y;
          count++;
        }
      }

      if (count > 20) {
        // Mirror X
        const avgX = 1 - (sumX / count) / 64;
        const avgY = (sumY / count) / 48;
        
        const dx = (avgX - lastPos.current.x) * 40; // Scale up velocity
        const dy = (avgY - lastPos.current.y) * 40;
        
        velocity.current.x = velocity.current.x * 0.6 + dx * 0.4;
        velocity.current.y = velocity.current.y * 0.6 + dy * 0.4;
        
        lastPos.current = { x: avgX, y: avgY };

        const speed = Math.sqrt(velocity.current.x**2 + velocity.current.y**2);
        const isSwing = speed > 3.5; // Threshold for swing

        onPacket({ x: avgX, y: avgY, vx: velocity.current.x, vy: velocity.current.y, swing: isSwing });
      }

      raf = requestAnimationFrame(process);
    };
    process();
    return () => cancelAnimationFrame(raf);
  }, [trackingColor]);

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.floor(((e.clientX - rect.left) / rect.width) * 64);
    const y = Math.floor(((e.clientY - rect.top) / rect.height) * 48);
    const ctx = canvasRef.current.getContext("2d");
    if (ctx) {
      const p = ctx.getImageData(x, y, 1, 1).data;
      setTrackingColor({ r: p[0], g: p[1], b: p[2] });
    }
  };

  return (
    <div className="relative overflow-hidden rounded-xl border-2 border-slate-700 bg-black">
      {/* Hidden processing canvas */}
      <canvas ref={canvasRef} width={64} height={48} className="absolute inset-0 h-full w-full opacity-0 pointer-events-none" />
      
      {/* Visible Video feed */}
      <video
        ref={videoRef}
        muted
        playsInline
        className="h-64 w-full object-cover mirror -scale-x-100"
      />
      
      {/* Interaction Layer */}
      <div 
        className="absolute inset-0 cursor-crosshair active:ring-4 ring-emerald-500/50"
        onClick={handleCanvasClick}
      >
        {!trackingColor && (
          <div className="flex h-full items-center justify-center bg-black/40">
            <p className="px-4 text-center text-sm font-bold text-white drop-shadow-md">
              Tap a colored object<br/>to track it
            </p>
          </div>
        )}
        {trackingColor && (
          <div 
            className="absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-sm transition-all duration-75 ease-linear"
            style={{ 
              left: `${lastPos.current.x * 100}%`, 
              top: `${lastPos.current.y * 100}%`,
              backgroundColor: `rgb(${trackingColor.r},${trackingColor.g},${trackingColor.b})`
            }}
          />
        )}
      </div>
    </div>
  );
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
  const [packetStats, setPacketStats] = useState({ packets: 0 });

  const [gameHud, setGameHud] = useState({
    player: 0,
    cpu: 0,
    rally: 0,
    winner: null as ScoreOwner | null,
    status: "Track an object to serve",
  });
  const [hostPhase, setHostPhase] = useState<HostPhase>("calibration");
  const [inputSource, setInputSource] = useState<InputSource>(null);

  const latestRef = useRef<InputPacket | null>(null);
  const sendingRef = useRef(false);
  const packetsRef = useRef(0);
  const controlRef = useRef<ControlState>({
    targetX: 0,
    targetY: 0,
    pendingSwing: null,
    lastSwingTime: 0,
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

    const interval = window.setInterval(poll, 16);
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
    if (!latest?.packet) return;

    const control = controlRef.current;
    if (latest.seq === control.lastSeq) return;
    control.lastSeq = latest.seq;

    updateControlFromPacket(control, latest.packet, latest.t);
  }, [latest]);

  useEffect(() => {
    if (role !== "phone") return;
    navigator.mediaDevices.enumerateDevices().then(devices => {
        setSensorAvailable(devices.some(d => d.kind === 'videoinput'));
    });
    setPermission("granted"); // Assume granted flow for camera usually prompts automatically
  }, [role]);

  // Host-local tracking handler (if using PC camera)
  const handleLocalPacket = (packet: InputPacket) => {
    const control = controlRef.current;
    updateControlFromPacket(control, packet, performance.now());
  };

  // Phone tracking handler (sends to host)
  const handlePhonePacket = (packet: InputPacket) => {
    latestRef.current = packet;
  };

  useEffect(() => {
    if (role !== "phone" || !session) return;

    packetsRef.current = 0;

    let mounted = true;

    const interval = window.setInterval(async () => {
      if (sendingRef.current || !mounted) return;
      if (!latestRef.current) return;

      sendingRef.current = true;

      try {
        await fetch("/api/motion", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session, packet: latestRef.current }),
        });

        packetsRef.current += 1;
        if (packetsRef.current % 4 === 0) {
          setPacketStats({ packets: packetsRef.current });
        }
      } catch {
        // Ignore transient network errors.
      } finally {
        sendingRef.current = false;
      }
    }, 16);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [role, session]);

  useEffect(() => {
    if (role !== "host") return;

    simRef.current = createSimState();
    controlRef.current = {
      targetX: 0,
      targetY: 0,
      pendingSwing: null,
      lastSwingTime: 0,
      lastSeq: -1,
    };
    setGameHud({
      player: 0,
      cpu: 0,
      rally: 0,
      winner: null,
      status: "Track object to serve",
    });
    setHostPhase("calibration");
    setInputSource(null);
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
    const bounceVoices = Array.from({ length: 3 }, () => new Audio("/bounce.mp3"));
    for (const voice of bounceVoices) {
      voice.preload = "auto";
      voice.volume = 0.55;
    }
    let bounceVoiceIndex = 0;

    const playBounceSound = (volume: number, playbackRate: number) => {
      const voice = bounceVoices[bounceVoiceIndex];
      bounceVoiceIndex = (bounceVoiceIndex + 1) % bounceVoices.length;
      voice.pause();
      voice.currentTime = 0;
      voice.volume = clamp(volume, 0, 1);
      voice.playbackRate = clamp(playbackRate, 0.65, 1.8);
      void voice.play().catch(() => {
        // Audio playback can fail due to browser autoplay policies.
      });
    };

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

      // Simplified visual rotation
      visual.swingPivot.rotation.set(
        0.25 + progress * 0.55 + avatar.pitch * 0.4, // Pitch influences forward tilt
        // Y rotation (yaw) modified by user input and swing progress
        (side === "player" ? 0.2 : -0.2) + avatar.roll * 0.5,
        baseZ + sweepZ * progress
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
        const speed = Math.abs(avatar.x - (avatar === sim.player ? control.targetX : sim.cpu.targetX));
        // Add little lean based on movement
        const moveLean = clamp(speed * 2, -0.5, 0.5);
        if (avatar === sim.player) avatar.roll = control.targetX * 0.5;
        
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
                playBounceSound(0.5, 1.14);
                sim.player.used = true;
                sim.player.flash = 0.11;
                match.status = "Rally live";
              }
            }
          } else {
            if (match.serveTimer <= 0 && sim.cpu.swingT <= 0 && sim.cpu.cooldown <= 0) {
              startSwing(
                sim.cpu,
                0.44 + Math.random() * 0.26,
                clamp((Math.random() - 0.5) * 0.72, -1, 1),
                clamp((Math.random() - 0.15) * 0.6, -1, 1),
              );
            }
            if (sim.cpu.swingT > 0 && !sim.cpu.used) {
              const progress = 1 - sim.cpu.swingT / SWING_DURATION;
              if (progress > 0.24 && progress < 0.78) {
                strikeBall(sim, "cpu", sim.cpu.power, sim.cpu.roll, sim.cpu.pitch, true);
                playBounceSound(0.48, 1.1);
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
              clamp(0.34 + bias * 0.22 + Math.random() * 0.18, 0.34, 0.78),
              clamp((sim.ballPos.x - sim.cpu.x) * 0.52 + (Math.random() - 0.5) * 0.2, -1, 1),
              clamp((Math.random() - 0.2) * 0.54, -1, 1),
            );
          }

          if (sim.player.swingT > 0 && !sim.player.used && canPlayerHit(sim)) {
            strikeBall(sim, "player", sim.player.power, sim.player.roll, sim.player.pitch, false);
            playBounceSound(0.52, 1.18);
            sim.player.used = true;
            sim.player.flash = 0.12;
          }

          if (sim.cpu.swingT > 0 && !sim.cpu.used && canCpuHit(sim)) {
            strikeBall(sim, "cpu", sim.cpu.power, sim.cpu.roll, sim.cpu.pitch, false);
            playBounceSound(0.5, 1.12);
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
            playBounceSound(0.62, 0.9);

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

  const requestCamera = async () => {
     // The CameraController handles the stream request.
     // This function is kept for button compatibility if needed.
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
    resetSimState(simRef.current);
    const control = controlRef.current;
    control.pendingSwing = null;
    control.lastSwingTime = 0;
    setGameHud({
      player: 0,
      cpu: 0,
      rally: 0,
      winner: null,
      status: "Track object to serve",
    });
  };


  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-950 font-sans text-slate-100 selection:bg-emerald-500/30">
      {/* Background Ambience */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black" />
      <div className="pointer-events-none absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-soft-light" />

      {/* Main Container */}
      <div className="relative z-10 flex h-screen max-h-screen flex-col">
        {/* Game Title Header - Hidden during gameplay */}
        {(role !== "host" || hostPhase !== "game") && (
          <header className="flex-none p-6 text-center">
            <h1 className="bg-gradient-to-br from-emerald-400 to-cyan-500 bg-clip-text text-4xl font-black italic tracking-tighter text-transparent drop-shadow-sm md:text-6xl">
              POCKET RACKET
            </h1>
            <p className="mt-2 text-sm font-medium uppercase tracking-wide text-slate-400">
              Local Multiplayer Tennis
            </p>
          </header>
        )}

        <div
          className={`flex w-full flex-1 flex-col items-center justify-center ${
            role === "host" && hostPhase === "game" ? "h-full p-0" : "mx-auto max-w-5xl p-4"
          }`}
        >
          {/* --- PHONE CONTROLLER VIEW --- */}
          {role === "phone" && (
            <div className="flex h-full w-full max-w-md flex-col justify-center gap-6">
              {/* Status Card */}
              <div className="rounded-3xl border border-slate-700 bg-slate-900/80 p-6 shadow-2xl backdrop-blur">
                <div className="mb-6 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-3 w-3 animate-pulse rounded-full ${
                        connected || packetsRef.current > 0 ? "bg-emerald-500" : "bg-rose-500"
                      }`}
                    />
                    <span className="text-sm font-bold uppercase tracking-wider text-slate-200">
                      {connected || packetsRef.current > 0 ? "Connected" : "Disconnected"}
                    </span>
                  </div>
                  <span className="font-mono text-xs text-slate-500">{session.slice(0, 4)}</span>
                </div>

                <div className="mb-4 aspect-[4/3] w-full overflow-hidden rounded-2xl border-2 border-slate-600">
                  <CameraController onPacket={handlePhonePacket} />
                </div>
                
                <p className="text-center text-xs text-slate-400">
                  Point camera at a distinct object (e.g. green cap). Tap it on screen to track.
                </p>
              </div>

              <p className="px-6 text-center text-xs text-slate-500">
                Packets sent: {packetStats.packets}
              </p>
            </div>
          )}

          {/* --- HOST VIEW --- */}
          {role === "host" && (
            <>
              {/* LOBBY PHASE: QR Code */}
              {hostPhase === "calibration" && !inputSource && (
                <div className="flex flex-col gap-6 text-center">
                   <h2 className="text-2xl font-bold text-white">Choose Input Method</h2>
                   <div className="flex gap-4">
                      <button 
                        onClick={() => setInputSource("pc")}
                        className="rounded-2xl border border-slate-700 bg-slate-900 p-8 hover:bg-slate-800 transition-colors"
                      >
                        <div className="text-4xl mb-2">💻</div>
                        <span className="font-bold">This Computer</span>
                        <p className="text-xs text-slate-500 mt-2">Use webcam attached to this PC</p>
                      </button>
                      <button 
                        onClick={() => setInputSource("phone")}
                        className="rounded-2xl border border-slate-700 bg-slate-900 p-8 hover:bg-slate-800 transition-colors"
                      >
                        <div className="text-4xl mb-2">📱</div>
                        <span className="font-bold">Phone Remote</span>
                        <p className="text-xs text-slate-500 mt-2">Scan QR code to use phone</p>
                      </button>
                   </div>
                </div>
              )}

              {hostPhase === "calibration" && inputSource === "phone" && !connected && (
                <div className="flex w-full max-w-2xl flex-col items-center gap-8 rounded-3xl border border-slate-700 bg-slate-900/80 p-8 shadow-2xl backdrop-blur md:flex-row">
                  <div className="shrink-0 rounded-xl bg-white p-4 shadow-inner">
                    {qrDataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={qrDataUrl}
                        alt="Join QR"
                        className="h-48 w-48 object-contain opacity-90 mix-blend-multiply"
                      />
                    ) : (
                      <div className="h-48 w-48 animate-pulse rounded bg-slate-100" />
                    )}
                  </div>
                  <div className="flex-1 space-y-6 text-center md:text-left">
                    <div>
                      <h2 className="mb-2 text-2xl font-bold text-white">Scan to Join</h2>
                      <p className="leading-relaxed text-slate-400">
                        Scan the QR code with your phone to connect it as your motion controller.
                      </p>
                    </div>
                    <div className="break-all rounded-xl border border-slate-800 bg-slate-950 p-4 font-mono text-xs text-slate-500">
                      {phoneUrl || "Generating..."}
                    </div>
                    <div className="flex justify-center gap-3 md:justify-start">
                      <button
                        onClick={copyPhoneLink}
                        className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
                      >
                        Copy Link
                      </button>
                      <button
                        onClick={() => window.open(phoneUrl, "_blank")}
                        className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-700"
                      >
                        Open Here
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* CALIBRATION PHASE */}
              {hostPhase === "calibration" && (inputSource === "pc" || connected) && (
                <div className="grid w-full max-w-4xl gap-6">
                  <div className="grid gap-4 md:grid-cols-2">
                    {/* Step 1 */}
                    <div className="flex flex-col items-center rounded-2xl border border-slate-800 bg-slate-900/50 p-6 text-center">
                      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-800 font-bold text-slate-400">
                        1
                      </div>
                      <h3 className="mb-2 font-bold text-slate-200">Prepare Object</h3>
                      <p className="text-sm text-slate-400">
                        Find a distinct colored object (e.g. orange cap, green ball).
                      </p>
                    </div>
                    {/* Step 2 */}
                    <div className="flex flex-col items-center rounded-2xl border border-slate-800 bg-slate-900/50 p-6 text-center">
                      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-slate-700 bg-slate-800 font-bold text-slate-400">
                        2
                      </div>
                      <h3 className="mb-2 font-bold text-slate-200">Track It</h3>
                      <p className="text-sm text-slate-400">
                        Tap the object on the video feed to start tracking.
                      </p>
                    </div>
                  </div>
                  
                  {/* PC Camera Calibration View */}
                  {inputSource === "pc" && (
                     <div className="mx-auto w-full max-w-sm rounded-2xl border border-slate-700 p-4 bg-slate-900">
                        <CameraController onPacket={handleLocalPacket} />
                     </div>
                  )}
                  
                  {inputSource === "phone" && (
                     <div className="text-center p-8">
                        <p className="text-emerald-400 animate-pulse font-bold">Waiting for tracking data from phone...</p>
                        <p className="text-slate-500 text-sm mt-2">Perform calibration on the phone screen</p>
                     </div>
                  )}

                  <div className="flex justify-center pt-6">
                    <button
                      onClick={() => setHostPhase("game")}
                      className="group relative rounded-full bg-emerald-500 px-12 py-4 text-xl font-black text-slate-950 transition-all hover:scale-105 hover:bg-emerald-400 hover:shadow-[0_0_40px_-10px_rgba(16,185,129,0.5)] disabled:bg-slate-800 disabled:text-slate-500 disabled:hover:scale-100 disabled:hover:shadow-none"
                    >
                      <span className="relative z-10 flex items-center gap-2">
                        START MATCH
                      </span>
                    </button>
                  </div>
                </div>
              )}

              {/* GAME PHASE */}
              {hostPhase === "game" && (
                <div className="relative flex h-full w-full flex-col">
                  {/* Canvas Container */}
                  <div className="relative flex-1 overflow-hidden bg-black shadow-2xl">
                    <div ref={renderMountRef} className="absolute inset-0 h-full w-full" />

                    {/* PC Camera PIP */}
                    {inputSource === "pc" && (
                        <div className="absolute right-4 top-4 z-50 w-48 rounded-lg border-2 border-slate-700 bg-black shadow-xl overflow-hidden opacity-80 hover:opacity-100 transition-opacity">
                            <CameraController onPacket={handleLocalPacket} />
                        </div>
                    )}

                    {/* Top HUD Overlay */}
                    <div className="pointer-events-none absolute left-0 right-0 top-0 flex items-start justify-between p-6">
                      {/* Player Score */}
                      <div className="flex flex-col items-center rounded-2xl border border-emerald-500/20 bg-slate-900/40 p-4 shadow-lg backdrop-blur-md">
                        <span className="mb-1 text-xs font-bold uppercase tracking-widest text-emerald-400">
                          Player
                        </span>
                        <span className="font-mono text-5xl font-black leading-none text-white">
                          {gameHud.player}
                        </span>
                      </div>

                      {/* Center Status */}
                      <div className="mt-2 rounded-full border border-slate-700/50 bg-slate-950/60 px-6 py-2 backdrop-blur">
                        <span className="text-sm font-medium uppercase tracking-wide text-slate-200 animate-pulse">
                          {gameHud.winner ? (
                            <span
                              className={
                                gameHud.winner === "player" ? "text-emerald-400" : "text-rose-400"
                              }
                            >
                              {gameHud.status}
                            </span>
                          ) : (
                            gameHud.status
                          )}
                        </span>
                      </div>

                      {/* CPU Score */}
                      <div className="flex flex-col items-center rounded-2xl border border-orange-500/20 bg-slate-900/40 p-4 shadow-lg backdrop-blur-md">
                        <span className="mb-1 text-xs font-bold uppercase tracking-widest text-orange-400">
                          CPU
                        </span>
                        <span className="font-mono text-5xl font-black leading-none text-white">
                          {gameHud.cpu}
                        </span>
                      </div>
                    </div>

                    {/* Bottom HUD Overlay */}
                    <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex items-end justify-between p-6">
                      <div className="rounded-xl border border-slate-800/50 bg-slate-900/30 p-3 backdrop-blur">
                        <div className="flex items-center gap-3">
                          <div className="flex flex-col">
                            <span className="text-[10px] uppercase text-slate-400">Rally</span>
                            <span className="font-mono text-xl font-bold text-slate-200">
                              {gameHud.rally}
                            </span>
                          </div>
                          <div className="h-8 w-px bg-slate-700/50" />
                          <div className="flex flex-col">
                            <span className="text-[10px] uppercase text-slate-400">Input</span>
                            <span
                              className={`font-mono text-sm font-bold ${
                                connected || inputSource === "pc" ? "text-emerald-400" : "text-rose-400"
                              }`}
                            >
                              {connected || inputSource === "pc" ? "Live" : "No Signal"}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* In-Game Buttons (Pointer Events Enabled) */}
                      <div className="pointer-events-auto flex gap-2">
                        {gameHud.winner && (
                          <button
                            onClick={resetMatch}
                            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-lg transition-colors hover:bg-emerald-500"
                          >
                            PLAY AGAIN
                          </button>
                        )}
                        <button
                          onClick={() => setHostPhase("calibration")}
                          className="rounded-lg border border-slate-700 bg-slate-800/80 px-4 py-2 text-xs font-bold text-slate-300 transition-colors backdrop-blur hover:bg-slate-700/80"
                        >
                          EXIT
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
