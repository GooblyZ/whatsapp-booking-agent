// app/api/webhook/route.ts
// Legacy alias — kept for backwards compatibility.
// Delegates to the canonical /api/webhook/whatsapp handler.
// Configure Meta to use /api/webhook/whatsapp for new registrations.

export { GET, POST } from "@/app/api/webhook/whatsapp/route";
