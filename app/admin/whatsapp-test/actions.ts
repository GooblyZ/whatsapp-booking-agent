"use server";

import { sendWhatsAppTextMessage, SendWhatsAppResult } from "@/lib/whatsapp/send-message";

export type SendTestState = SendWhatsAppResult | null;

export async function sendTestWhatsAppMessage(
  _prevState: SendTestState,
  formData: FormData
): Promise<SendTestState> {
  const to = formData.get("to");
  const body = formData.get("body");

  if (typeof to !== "string" || !to.trim())
    return { success: false, error: "Recipient phone number is required." };
  if (typeof body !== "string" || !body.trim())
    return { success: false, error: "Message body is required." };

  return sendWhatsAppTextMessage({ to: to.trim(), body: body.trim() });
}
