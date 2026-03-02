# Pocket Racket Tennis

A local-network tennis mini-game built with Next.js where your phone acts as the player's racket.

## Features

- QR pairing between host (PC) and phone
- Live motion streaming (`deviceorientation` + `devicemotion`)
- Tilt-to-move player racket
- Swing-to-power mechanic from gyro/acceleration data
- CPU opponent, scoring, and set reset

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` on your PC.

## Play flow

1. Keep the host view open on your PC.
2. Scan the QR code with your phone.
3. On phone, tap **Enable Motion Access**.
4. Tilt the phone left/right to move the racket.
5. Swing harder for stronger returns.

## Notes

- If your phone cannot reach `localhost`, use your PC LAN IP (for example `http://192.168.x.x:3000`).
- Many mobile browsers require HTTPS for motion sensors; if data does not stream, test over HTTPS/tunnel.
- Motion data is stored in-memory per session and automatically pruned.
