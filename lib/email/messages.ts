import { config } from "@/lib/config";
import { sendEmail, type EmailOutcome } from "@/lib/email/send";

/**
 * The messages MantraMed sends.
 *
 * Kept apart from the frame and the transport so the wording is in one place
 * and can be read end to end. Every one of these goes to a pharmacy owner who
 * did not ask for it at that moment, so each says plainly who it is from,
 * what it is about, and what to do if it was not expected.
 */

/**
 * Credentials for a newly opened account.
 *
 * The password is in the message because that is how the account is handed
 * over: superadmin sets it while opening the pharmacy, often while the owner
 * is on the phone, and the owner needs it to get in. The cost is that it then
 * lives in a mailbox indefinitely - so the mail says so, in its own panel,
 * and tells them to change it. `lib/password-reset.ts` is what makes that a
 * one-click job rather than a support request.
 */
export function sendPharmacyWelcomeEmail(input: {
  to: string;
  ownerName: string;
  pharmacyName: string;
  email: string;
  password: string;
}): Promise<EmailOutcome> {
  const signIn = `${config.appUrl}/login`;

  return sendEmail({
    to: input.to,
    subject: `Your MantraMed account for ${input.pharmacyName}`,
    content: {
      heading: `${input.pharmacyName} is ready`,
      intro: [
        `Hello ${input.ownerName},`,
        `An account has been opened for ${input.pharmacyName} on MantraMed. Sign in with the details below to set up your catalogue and start billing.`,
      ],
      blocks: [
        {
          label: "Your sign-in details",
          rows: [
            { name: "Email", value: input.email },
            { name: "Password", value: input.password },
          ],
        },
        {
          caution:
            "Change this password once you are in, from Staff → your account. A password sent by email stays in your mailbox, and anyone who reaches that mailbox can reach your till.",
        },
      ],
      button: { label: "Sign in to MantraMed", url: signIn },
      outro: [
        `If the button does not work, open ${signIn} in your browser.`,
        "Your pharmacy's registered name, PAN, VAT number and licence numbers are set by MantraMed from your registration papers and print on every bill. Everything else - your address, phone, bill wording - is yours to edit under Settings.",
        "If you were not expecting this, reply to this email and we will close the account.",
      ],
    },
  });
}

/**
 * New credentials, issued by support rather than asked for.
 *
 * The recovery path when the welcome mail never arrived - the original
 * password is bcrypt-hashed and cannot be read back, so re-sending it is not
 * possible; a new one has to be set and delivered. It is also what a shop
 * gets when they phone up locked out.
 *
 * Deliberately not the welcome wording. "Your account is ready" is alarming
 * for a shop that has been trading for a month, and an owner who did not ask
 * for this needs to know at once that somebody at the platform did it.
 */
export function sendOwnerCredentialsEmail(input: {
  to: string;
  ownerName: string;
  pharmacyName: string;
  email: string;
  password: string;
}): Promise<EmailOutcome> {
  const signIn = `${config.appUrl}/login`;

  return sendEmail({
    to: input.to,
    subject: `New sign-in details for ${input.pharmacyName}`,
    content: {
      heading: "Your password has been reset",
      intro: [
        `Hello ${input.ownerName},`,
        `MantraMed support has set a new password on the account for ${input.pharmacyName}. Your previous password no longer works.`,
      ],
      blocks: [
        {
          label: "Your sign-in details",
          rows: [
            { name: "Email", value: input.email },
            { name: "Password", value: input.password },
          ],
        },
        {
          caution:
            "Change this password once you are in, from Staff → your account. A password sent by email stays in your mailbox, and anyone who reaches that mailbox can reach your till.",
        },
      ],
      button: { label: "Sign in to MantraMed", url: signIn },
      outro: [
        `If the button does not work, open ${signIn} in your browser.`,
        "If you did not ask for this and were not expecting a call from us, reply to this email straight away.",
      ],
    },
  });
}

/**
 * A password reset link.
 *
 * Deliberately says how long it lasts and that it can be ignored. Somebody
 * who did not ask for this needs to know that doing nothing is safe and that
 * their current password still works - otherwise the honest reaction to an
 * unexpected reset mail is to panic and change something.
 */
export function sendPasswordResetEmail(input: {
  to: string;
  name: string;
  url: string;
  minutesValid: number;
}): Promise<EmailOutcome> {
  return sendEmail({
    to: input.to,
    subject: "Reset your MantraMed password",
    content: {
      heading: "Reset your password",
      intro: [
        `Hello ${input.name},`,
        `Someone asked to reset the password for this MantraMed account. Use the button below to choose a new one. The link works once and expires in ${input.minutesValid} minutes.`,
      ],
      button: { label: "Choose a new password", url: input.url },
      outro: [
        `If the button does not work, copy this link into your browser: ${input.url}`,
        "If you did not ask for this, you can ignore this email - nothing changes and your current password keeps working.",
      ],
    },
  });
}
