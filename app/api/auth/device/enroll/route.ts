// app/api/auth/device/enroll/route.ts
//
// Consumes a one-time, admin-issued enrolment token to pair a technician's
// device for the first time (docs/05-users-auth.md). Mechanical follow-on of
// Task 14's magic-link issuance — see lib/auth/device-enrollment.ts for why
// this route doesn't mint a full Auth.js session (Phase-0 scope note: the
// unlock route + lockout is the required, tested deliverable for Task 15,
// not enrolment).
import { db } from '@/lib/db'
import { consumeDeviceEnrollment } from '@/lib/auth/device-enrollment'

export async function POST(request: Request) {
  const { enrollmentToken, deviceLabel, pin } = (await request.json()) as {
    enrollmentToken: string
    deviceLabel: string
    pin: string
  }

  const result = await consumeDeviceEnrollment(db, { token: enrollmentToken, deviceLabel, pin })
  if (!result) {
    return new Response('Invalid or expired enrollment token', { status: 400 })
  }

  return Response.json({ status: 'ok', deviceId: result.deviceId })
}
