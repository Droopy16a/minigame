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

function makeSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function Home() {
  const [role, setRole] = useState<"host" | "phone">("host");
  const [session, setSession] = useState<string>("");
  const [phoneUrl, setPhoneUrl] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [latest, setLatest] = useState<StoreEntry | null>(null);
  const [permission, setPermission] = useState<
    "unknown" | "granted" | "denied"
  >("unknown");

  const latestRef = useRef<MotionSample | null>(null);
  const sendingRef = useRef(false);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const targetEulerRef = useRef(new THREE.Euler(0, 0, 0, "ZXY"));
  const cubeRef = useRef<THREE.Mesh | null>(null);

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
    const base = `${window.location.origin}${window.location.pathname}`;
    const url = `${base}?role=phone&session=${encodeURIComponent(session)}`;
    setPhoneUrl(url);

    QRCode.toDataURL(url, { margin: 1, width: 240 })
      .then((dataUrl) => setQrDataUrl(dataUrl))
      .catch(() => setQrDataUrl(""));
  }, [session]);

  useEffect(() => {
    if (role !== "host" || !session) return;
    let mounted = true;
    const poll = async () => {
      try {
        const res = await fetch(`/api/motion?session=${session}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!mounted) return;
        if (data?.entry) {
          setLatest(data.entry as StoreEntry);
        }
      } catch {
        // ignore transient errors
      }
    };

    const interval = setInterval(poll, 50);
    poll();

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [role, session]);

  useEffect(() => {
    if (role !== "host") return;
    if (!canvasRef.current) return;

    const mount = canvasRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b0b0f");

    const camera = new THREE.PerspectiveCamera(
      50,
      mount.clientWidth / mount.clientHeight,
      0.1,
      100,
    );
    camera.position.set(0, 0, 5);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.7);
    directional.position.set(2, 3, 4);
    scene.add(directional);

    const geometry = new THREE.BoxGeometry(1.4, 1.4, 1.4);
    const material = new THREE.MeshStandardMaterial({
      color: 0x4ade80,
      metalness: 0.2,
      roughness: 0.4,
    });
    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);
    cubeRef.current = cube;

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    };
    window.addEventListener("resize", resize);

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      if (cubeRef.current) {
        const target = targetEulerRef.current;
        cubeRef.current.rotation.x += (target.x - cubeRef.current.rotation.x) * 0.15;
        cubeRef.current.rotation.y += (target.y - cubeRef.current.rotation.y) * 0.15;
        cubeRef.current.rotation.z += (target.z - cubeRef.current.rotation.z) * 0.15;
      }
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      cubeRef.current = null;
      mount.removeChild(renderer.domElement);
    };
  }, [role]);

  useEffect(() => {
    if (role !== "phone" || !session) return;

    let motionHandler: ((event: DeviceMotionEvent) => void) | null = null;
    let orientationHandler: ((event: DeviceOrientationEvent) => void) | null =
      null;

    motionHandler = (event) => {
      const sample = latestRef.current ?? {
        orientation: null,
        rotationRate: null,
        acceleration: null,
        accelerationIncludingGravity: null,
        interval: null,
      };

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

      sample.accelerationIncludingGravity =
        event.accelerationIncludingGravity
          ? {
              x: event.accelerationIncludingGravity.x ?? null,
              y: event.accelerationIncludingGravity.y ?? null,
              z: event.accelerationIncludingGravity.z ?? null,
            }
          : null;

      sample.interval = event.interval ?? null;
      latestRef.current = sample;
    };

    orientationHandler = (event) => {
      const sample = latestRef.current ?? {
        orientation: null,
        rotationRate: null,
        acceleration: null,
        accelerationIncludingGravity: null,
        interval: null,
      };

      sample.orientation = {
        alpha: event.alpha ?? null,
        beta: event.beta ?? null,
        gamma: event.gamma ?? null,
        absolute: event.absolute ?? null,
      };

      latestRef.current = sample;
    };

    window.addEventListener("devicemotion", motionHandler);
    window.addEventListener("deviceorientation", orientationHandler);

    const interval = setInterval(async () => {
      if (!latestRef.current || sendingRef.current) return;
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
      } catch {
        // ignore transient errors
      } finally {
        sendingRef.current = false;
      }
    }, 33);

    return () => {
      window.removeEventListener("devicemotion", motionHandler);
      window.removeEventListener("deviceorientation", orientationHandler);
      clearInterval(interval);
    };
  }, [role, session]);

  const connected = useMemo(() => {
    if (!latest) return false;
    return Date.now() - latest.t < 1200;
  }, [latest]);

  useEffect(() => {
    if (!latest?.sample?.orientation) return;
    const { alpha, beta, gamma } = latest.sample.orientation;
    if (alpha == null || beta == null || gamma == null) return;

    const degToRad = THREE.MathUtils.degToRad;
    targetEulerRef.current.set(
      degToRad(beta),
      degToRad(gamma),
      degToRad(alpha),
      "ZXY",
    );
  }, [latest]);

  const requestPermission = async () => {
    try {
      let granted = false;
      const motion = DeviceMotionEvent as unknown as {
        requestPermission?: () => Promise<"granted" | "denied">;
      };
      const orientation = DeviceOrientationEvent as unknown as {
        requestPermission?: () => Promise<"granted" | "denied">;
      };

      if (motion?.requestPermission) {
        const res = await motion.requestPermission();
        granted = res === "granted";
      }
      if (orientation?.requestPermission) {
        const res = await orientation.requestPermission();
        granted = granted && res === "granted";
      }

      setPermission(granted ? "granted" : "denied");
    } catch {
      setPermission("denied");
    }
  };

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">
            Motion Link
          </p>
          <h1 className="text-3xl font-semibold">Phone motion to PC</h1>
          <p className="text-sm text-zinc-400">
            Scan the QR on your phone to open the local page and stream gyro
            data.
          </p>
        </header>

        <div className="grid gap-6 md:grid-cols-2">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
            <h2 className="text-lg font-semibold">
              {role === "host" ? "Host (PC)" : "Phone"}
            </h2>
            <p className="mt-1 text-sm text-zinc-400">
              Session: <span className="text-zinc-200">{session || "..."}</span>
            </p>

            {role === "host" ? (
              <div className="mt-4 flex flex-col gap-4">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="h-40 w-40 rounded-xl bg-zinc-800 p-2">
                    {qrDataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={qrDataUrl}
                        alt="QR code"
                        className="h-full w-full rounded-lg bg-white p-2"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
                        Generating QR...
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 text-sm text-zinc-300">
                    <div className="rounded-lg bg-zinc-800/70 p-2">
                      {phoneUrl || "..."}
                    </div>
                    <button
                      onClick={() => navigator.clipboard.writeText(phoneUrl)}
                      className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800"
                    >
                      Copy link
                    </button>
                    <button
                      onClick={() => window.open(phoneUrl, "_blank")}
                      className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800"
                    >
                      Open phone view
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                    Live Cube
                  </p>
                  <div
                    ref={canvasRef}
                    className="mt-3 h-56 w-full overflow-hidden rounded-lg border border-zinc-800"
                  />
                </div>

                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="flex items-center gap-2 text-sm">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        connected ? "bg-emerald-400" : "bg-zinc-600"
                      }`}
                    />
                    {connected ? "Receiving motion" : "Waiting for phone"}
                  </div>
                  <pre className="mt-3 max-h-64 overflow-auto text-xs text-zinc-300">
                    {latest
                      ? JSON.stringify(latest.sample, null, 2)
                      : "No data yet."}
                  </pre>
                </div>
              </div>
            ) : (
              <div className="mt-4 flex flex-col gap-4 text-sm text-zinc-300">
                <p>
                  This page streams your device motion data to the host
                  session.
                </p>
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
                  <div className="flex items-center justify-between">
                    <span>Permission</span>
                    <span className="text-xs text-zinc-400">
                      {permission}
                    </span>
                  </div>
                  <button
                    onClick={requestPermission}
                    className="mt-3 w-full rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800"
                  >
                    Enable motion access
                  </button>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 text-xs text-zinc-400">
                  Keep this screen open and unlocked while moving the phone.
                </div>
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6">
            <h2 className="text-lg font-semibold">How it works</h2>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm text-zinc-400">
              <li>Run the dev server on your PC.</li>
              <li>Scan the QR code with your phone.</li>
              <li>Allow motion permissions on the phone.</li>
              <li>Watch the live JSON on the host panel.</li>
            </ol>
            <p className="mt-4 text-xs text-zinc-500">
              Tip: Some mobile browsers require HTTPS for motion sensors. If you
              see no data, try using a local HTTPS tunnel or a trusted dev
              certificate.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
