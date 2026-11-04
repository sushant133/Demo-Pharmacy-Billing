"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/client";

/** "Send now": retry everything this pharmacy still owes IRD, immediately. */
export function SendNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setMessage(null);
    const result = await apiFetch<{ attempted: number }>("/api/cbms/retry", { method: "POST" });
    setBusy(false);
    setMessage(
      result.ok
        ? result.data.attempted === 0
          ? "Nothing was waiting."
          : `Tried ${result.data.attempted}. The list below shows what IRD said.`
        : result.message,
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={send} disabled={busy} className="btn-primary">
        {busy ? "Sending…" : "Send now"}
      </button>
      {message ? (
        <p role="status" className="text-xs text-slate-500">
          {message}
        </p>
      ) : null}
    </div>
  );
}
