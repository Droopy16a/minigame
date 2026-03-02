"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

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

type PermissionRequestCapable = {
  requestPermission?: () => Promise<"granted" | "denied">;
};

type WakeLockSentinelLike = {
  release: () => Promise<void>;
};

type WakeLockCapableNavigator = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

type ControlState = {
  roll: number;
  pitch: number;
  yaw: number;
  racketRoll: number;
  racketPitch: number;
  racketYaw: number;
  neutralReady: boolean;
  neutralRoll: number;
  neutralPitch: number;
  neutralYaw: number;
  lastSeq: number;
};

const CONNECTION_TIMEOUT_MS = 1200;
const ROLL_RANGE_DEG = 34;
const PITCH_RANGE_DEG = 46;
const YAW_RANGE_DEG = 64;
const ORIENTATION_SMOOTHING = 0.32;

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

function updateControlFromSample(control: ControlState, sample: MotionSample | null) {
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
}

function createFallbackRacket() {
  const racket = new THREE.Group();
  const handleMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.35, metalness: 0.3 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0x93c5fd, roughness: 0.25, metalness: 0.26 });

  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.75, 14), handleMat);
  handle.position.set(0, -0.35, 0);
  handle.rotation.z = -0.25;
  racket.add(handle);

  const head = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.04, 14, 32), headMat);
  head.rotation.x = Math.PI / 2;
  head.position.set(0.05, 0.1, 0);
  racket.add(head);

  return racket;
}

export default function RacketTrackerPage() {
  const [role, setRole] = useState<"host" | "phone">("host");
  const [session, setSession] = useState("");
  const [phoneUrl, setPhoneUrl] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [latest, setLatest] = useState<StoreEntry | null>(null);
  const [permission, setPermission] = useState<PermissionState>("unknown");
  const [sensorAvailable, setSensorAvailable] = useState(true);
  const [clock, setClock] = useState(() => Date.now());
  const [orientationHud, setOrientationHud] = useState({ roll: 0, pitch: 0, yaw: 0 });
  const [phoneTelemetry, setPhoneTelemetry] = useState({ roll: 0, pitch: 0, yaw: 0, packets: 0 });
  const [neutralReady, setNeutralReady] = useState(false);

  const renderMountRef = useRef<HTMLDivElement | null>(null);
  const latestRef = useRef<MotionSample | null>(null);
  const sendingRef = useRef(false);
  const packetsRef = useRef(0);
  const controlRef = useRef<ControlState>({
    roll: 0,
    pitch: 0,
    yaw: 0,
    racketRoll: 0,
    racketPitch: 0,
    racketYaw: 0,
    neutralReady: false,
    neutralRoll: 0,
    neutralPitch: 0,
    neutralYaw: 0,
    lastSeq: -1,
  });

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
    if (!latest?.sample) return;

    const control = controlRef.current;
    if (latest.seq === control.lastSeq) return;
    control.lastSeq = latest.seq;

    updateControlFromSample(control, latest.sample);
    setNeutralReady(control.neutralReady);
    setOrientationHud({
      roll: control.roll,
      pitch: control.pitch,
      yaw: control.yaw,
    });
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
    if (role !== "phone") return;

    const wakeCapableNav = navigator as WakeLockCapableNavigator;
    let active = true;
    let wakeLock: WakeLockSentinelLike | null = null;

    const requestWakeLock = async () => {
      if (!active || document.visibilityState !== "visible") return;
      if (!wakeCapableNav.wakeLock?.request) return;

      try {
        wakeLock = await wakeCapableNav.wakeLock.request("screen");
      } catch {
        // Ignore unsupported or blocked wake lock attempts.
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void requestWakeLock();
      }
    };

    void requestWakeLock();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (wakeLock) {
        void wakeLock.release().catch(() => {
          // Ignore release errors during teardown.
        });
      }
    };
  }, [role]);

  useEffect(() => {
    if (role !== "phone" || !session) return;

    latestRef.current = blankSample();
    packetsRef.current = 0;
    setPhoneTelemetry({ roll: 0, pitch: 0, yaw: 0, packets: 0 });

    let mounted = true;
    let lastPreview = 0;

    const publishPreview = () => {
      const now = performance.now();
      if (now - lastPreview < 100) return;
      lastPreview = now;

      const sample = latestRef.current;
      const roll = getRawRoll(sample);
      const pitch = getRawPitch(sample);
      const yaw = getRawYaw(sample);
      setPhoneTelemetry((prev) => ({
        ...prev,
        roll: roll == null ? prev.roll : clamp(roll / 45, -1, 1),
        pitch: pitch == null ? prev.pitch : clamp((pitch - 20) / 65, -1, 1),
        yaw: yaw == null ? prev.yaw : clamp((yaw - 180) / 180, -1, 1),
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
    if (!renderMountRef.current) return;

    const mount = renderMountRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b1726");
    scene.fog = new THREE.Fog(0x0b1726, 6, 16);

    const camera = new THREE.PerspectiveCamera(
      52,
      mount.clientWidth / Math.max(1, mount.clientHeight),
      0.1,
      100,
    );
    camera.position.set(0, 1.5, 3.4);
    camera.lookAt(0, 1, 0);
    scene.add(camera);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xb7dcff, 0x203348, 0.75);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.1);
    dir.position.set(-2.4, 4.2, 3.2);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    scene.add(dir);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4.5, 48),
      new THREE.MeshStandardMaterial({ color: 0x1d3148, roughness: 0.86, metalness: 0.03 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.02;
    floor.receiveShadow = true;
    scene.add(floor);

    const pivot = new THREE.Group();
    pivot.position.set(0, 1.0, 0);
    scene.add(pivot);

    const fallback = createFallbackRacket();
    fallback.castShadow = true;
    fallback.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
      }
    });
    pivot.add(fallback);

    let disposed = false;
    const loader = new GLTFLoader();
    loader.load(
      "/racket.gltf",
      (gltf) => {
        if (disposed) return;

        pivot.remove(fallback);
        const model = gltf.scene;
        model.scale.set(1.15, 1.15, 1.15);
        model.rotation.set(0, Math.PI, 0.08);
        model.position.set(0, 0, 0);
        model.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
            if (Array.isArray(obj.material)) {
              for (const mat of obj.material) {
                mat.side = THREE.DoubleSide;
              }
            } else {
              obj.material.side = THREE.DoubleSide;
            }
          }
        });
        pivot.add(model);
      },
      undefined,
      () => {
        // Keep fallback racket when glTF cannot be loaded.
      },
    );

    const resize = () => {
      const w = mount.clientWidth;
      const h = Math.max(1, mount.clientHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    };
    window.addEventListener("resize", resize);

    let raf = 0;
    const animate = () => {
      const control = controlRef.current;

      const targetRotX = clamp(-control.racketPitch * 0.85, -1.3, 1.3);
      const targetRotY = clamp(control.racketYaw * 0.9, -1.5, 1.5);
      const targetRotZ = clamp(-control.racketRoll, -1.4, 1.4);

      pivot.rotation.x = THREE.MathUtils.lerp(pivot.rotation.x, targetRotX, 0.22);
      pivot.rotation.y = THREE.MathUtils.lerp(pivot.rotation.y, targetRotY, 0.22);
      pivot.rotation.z = THREE.MathUtils.lerp(pivot.rotation.z, targetRotZ, 0.22);

      pivot.position.x = THREE.MathUtils.lerp(pivot.position.x, control.roll * 0.62, 0.18);
      pivot.position.y = THREE.MathUtils.lerp(pivot.position.y, 1 + -control.pitch * 0.22, 0.18);

      renderer.render(scene, camera);
      raf = window.requestAnimationFrame(animate);
    };

    resize();
    raf = window.requestAnimationFrame(animate);

    return () => {
      disposed = true;
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

  const recenter = () => {
    const control = controlRef.current;
    const sample = latest?.sample ?? null;
    const roll = getRawRoll(sample);
    const pitch = getRawPitch(sample);
    const yaw = getRawYaw(sample);

    if (roll === null || pitch === null) return;

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
    setNeutralReady(true);
    setOrientationHud({ roll: 0, pitch: 0, yaw: 0 });
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/70">Pocket Racket</p>
            <h1 className="text-3xl font-semibold">Racket Movement Debug</h1>
            <p className="text-sm text-slate-300/85">
              Isolated tracker page: one racket model that follows phone orientation.
            </p>
          </div>
          <Link
            href="/"
            className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800"
          >
            Back to Match
          </Link>
        </header>

        {role === "host" ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="text-sm text-slate-300">
                <p>
                  Session: <span className="text-slate-100">{session || "..."}</span>
                </p>
                <p>
                  Neutral: <span className="text-slate-100">{neutralReady ? "Ready" : "Not calibrated"}</span>
                </p>
              </div>
              <div className="flex items-center gap-2 rounded-full border border-slate-700/80 px-3 py-1 text-xs">
                <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400" : "bg-slate-500"}`} />
                {connected ? "Phone connected" : "Waiting for phone"}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-4">
              <div className="h-36 w-36 rounded-xl bg-slate-800 p-2">
                {qrDataUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qrDataUrl} alt="Session QR" className="h-full w-full rounded-lg bg-white p-2" />
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
                    onClick={recenter}
                    className="rounded-lg border border-cyan-600/70 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200 hover:bg-cyan-500/20"
                  >
                    Recenter
                  </button>
                </div>
              </div>
            </div>

            <div
              ref={renderMountRef}
              className="mt-4 aspect-[16/10] w-full overflow-hidden rounded-xl border border-slate-800 bg-slate-950"
            />

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Roll</p>
                <p className="mt-1 text-xl font-semibold text-slate-100">{orientationHud.roll.toFixed(2)}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Pitch</p>
                <p className="mt-1 text-xl font-semibold text-slate-100">{orientationHud.pitch.toFixed(2)}</p>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Yaw</p>
                <p className="mt-1 text-xl font-semibold text-slate-100">{orientationHud.yaw.toFixed(2)}</p>
              </div>
            </div>
          </section>
        ) : (
          <section className="rounded-2xl border border-slate-800 bg-slate-900/65 p-6 text-sm text-slate-200">
            <p>Keep this page open on your phone and move it like a racket.</p>

            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
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

            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Live telemetry</p>
              <p className="mt-2 text-sm text-slate-300">
                Roll {phoneTelemetry.roll.toFixed(2)} | Pitch {phoneTelemetry.pitch.toFixed(2)}
              </p>
              <p className="mt-1 text-sm text-slate-300">Yaw {phoneTelemetry.yaw.toFixed(2)}</p>
              <p className="mt-1 text-xs text-slate-400">Packets sent: {phoneTelemetry.packets}</p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
