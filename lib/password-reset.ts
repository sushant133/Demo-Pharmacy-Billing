import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "@/lib/api";
import { hashPassword } from "@/lib/auth";
import { config } from "@/lib/config";
import { connectDB } from "@/lib/db";
import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from "@/lib/email/messages";
import { PasswordReset } from "@/models/PasswordReset";
import { User } from "@/models/User";

/**
 * Forgotten passwords.
 *
 * The shape is the standard one, and the details are where it is usually got
 * wrong, so they are spelled out here:
 *
 *   - **Requesting a reset never says whether the address exists.** The reply
 *     is identical either way. A form that answers "no such account" is an
 *     account-enumeration oracle, and on this platform the addresses are
 *     pharmacy owners.
 *   - **The token is random, not derived.** 32 bytes from the CSPRNG, so it
 *     cannot be guessed from the account, the time, or another token.
 *   - **Only its hash is stored.** See models/PasswordReset.ts.
 *   - **Using one spends every other outstanding request for that account.**
 *     If somebody asked three times, the third link working should not leave
 *     the first two live in a mailbox.
 *   - **Completing one is confirmed by email**, to the address on the
 *     account and carrying no password. An unexpected *request* can be
 *     safely ignored; an unexpected *completion* is the thing an owner has
 *     to hear about, and it is the only notice they get.
 *
 * What this deliberately does **not** do is end sessions that are already
 * signed in. Sessions are stateless JWTs - `verifySession` does no database
 * read, which is what keeps every request cheap - so revoking one would mean
 * a lookup on every request across the whole app. A reset therefore changes
 * what the password is, and anybody already holding a cookie keeps working
 * until it expires, which is at most `AUTH_SESSION_TTL` (12 hours by
 * default). `passwordChangedAt` is recorded so that check can be added later
 * without a migration; nothing reads it yet.
 */

/** How long a link is good for. Long enough to find the email, no longer. */
export const RESET_TTL_MINUTES = 60;

/** 32 bytes of CSPRNG, url-safe. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Start a reset for an email address.
 *
 * Returns nothing about whether the address matched. The caller replies the
 * same way regardless - see the note above.
 */
export async function requestPasswordReset(
  email: string,
  requestedIp = "",
): Promise<void> {
  await connectDB();

  const user = await User.findOne({ email: email.trim().toLowerCase() })
    .select("_id name email isActive")
    .lean();

  // A deactivated account gets no link either. Silently, for the same reason.
  if (!user || user.isActive === false) return;

  const token = newToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

  await PasswordReset.create({
    userId: user._id,
    tokenHash: hashToken(token),
    expiresAt,
    requestedIp,
  });

  const url = `${config.appUrl}/reset-password?token=${encodeURIComponent(token)}`;

  // Failure is logged by the transport and swallowed here: telling the caller
  // that sending failed would leak that the address exists.
  await sendPasswordResetEmail({
    to: user.email,
    name: user.name,
    url,
    minutesValid: RESET_TTL_MINUTES,
  });
}

/**
 * The stored request a raw token refers to, if it is still good for one use.
 *
 * `null` for every failure - unknown, expired, already spent - because the
 * screen says the same thing for all three: ask for a new link.
 */
async function liveRequest(token: string) {
  const candidate = token.trim();
  if (!candidate) return null;

  await connectDB();
  const row = await PasswordReset.findOne({ tokenHash: hashToken(candidate) });
  if (!row) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  /*
    The lookup above is already by exact hash, so this comparison can only
    succeed - it is here so the hash is never compared with `===` anywhere in
    this file, and nobody later copies the loose version into a path where
    the timing does matter.
  */
  const a = Buffer.from(row.tokenHash, "hex");
  const b = Buffer.from(hashToken(candidate), "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  return row;
}

/** Is this link still worth showing a form for? */
export async function passwordResetIsValid(token: string): Promise<boolean> {
  return (await liveRequest(token)) !== null;
}

/**
 * Complete a reset.
 *
 * Throws a plain message on a dead link, because by this point the person is
 * looking at a form they were invited to fill in and deserves to be told why
 * it will not go through.
 */
export async function completePasswordReset(
  token: string,
  password: string,
): Promise<{ email: string }> {
  const row = await liveRequest(token);
  if (!row) {
    throw ApiError.badRequest(
      "This reset link has expired or has already been used. Ask for a new one.",
    );
  }

  const user = await User.findById(row.userId).select("name email isActive");
  if (!user || user.isActive === false) {
    throw ApiError.badRequest("That account is no longer active.");
  }

  user.passwordHash = await hashPassword(password);
  user.passwordChangedAt = new Date();
  // Chosen by the owner themselves, so it satisfies a pending forced change.
  user.mustChangePassword = false;
  await user.save();

  // Spend this one, and every other request outstanding for the account.
  row.usedAt = new Date();
  await row.save();
  await PasswordReset.updateMany(
    { userId: row.userId, usedAt: null },
    { $set: { usedAt: new Date() } },
  );

  /*
    Tell the address on the account that its password changed.

    After the save and the spending, deliberately: the reset has happened
    either way, and `sendEmail` reports rather than throws, so a relay that is
    down costs the receipt and not the reset. Whoever did this is already at
    the sign-in screen - the message is for the owner who did not.

    `user.email` rather than anything the form carried: a notice that somebody
    spent a reset link is only worth sending if it reaches the real account.
  */
  await sendPasswordChangedEmail({ to: user.email, name: user.name });

  return { email: user.email };
}
