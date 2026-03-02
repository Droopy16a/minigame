import { NextResponse } from "next/server";

type StoreEntry = {
  t: number;
  seq: number;
  sample: unknown;
};

const SESSION_TTL_MS = 15 * 60 * 1000;

const globalStore = globalThis as typeof globalThis & {
  __motionStore?: Map<string, StoreEntry>;
};

const store: Map<string, StoreEntry> =
  globalStore.__motionStore ?? new Map<string, StoreEntry>();
globalStore.__motionStore = store;

function pruneStore(now: number) {
  for (const [session, entry] of store.entries()) {
    if (now - entry.t > SESSION_TTL_MS) {
      store.delete(session);
    }
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const session = typeof body?.session === "string" ? body.session : "";
    if (!session) {
      return NextResponse.json(
        { ok: false, error: "Missing session" },
        { status: 400 },
      );
    }

    const now = Date.now();
    pruneStore(now);

    const prev = store.get(session);
    const entry: StoreEntry = {
      t: now,
      seq: (prev?.seq ?? 0) + 1,
      sample: body?.sample ?? null,
    };

    store.set(session, entry);
    return NextResponse.json({ ok: true, seq: entry.seq, t: entry.t });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const session = searchParams.get("session");
  if (!session) {
    return NextResponse.json(
      { ok: false, error: "Missing session" },
      { status: 400 },
    );
  }

  pruneStore(Date.now());
  const entry = store.get(session) ?? null;
  return NextResponse.json(
    { ok: true, entry },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
