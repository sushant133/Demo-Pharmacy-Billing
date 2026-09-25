import { describe, expect, it, vi } from "vitest";
import { config } from "@/lib/config";
import { forgotPasswordSchema, resetPasswordSchema } from "@/lib/validation";
import { buildMimeMessage } from "@/lib/email/google";
import { sendPasswordChangedEmail } from "@/lib/email/messages";
import {
  escapeHtml,
  renderEmail,
  renderEmailText,
  type EmailContent,
} from "@/lib/email/layout";

/**
 * The transport, stubbed.
 *
 * Every message in lib/email/messages.ts ends in `sendEmail`, so capturing it
 * is how the wording gets read back without a relay. What `sendEmail` itself
 * promises - that it never throws, and logs the message when nothing is
 * configured - is a separate contract and not what these assertions are about.
 */
const sent = vi.hoisted(
  () => [] as Array<{ to: string; subject: string; content: EmailContent }>,
);

vi.mock("@/lib/email/send", () => ({
  sendEmail: async (message: {
    to: string;
    subject: string;
    content: EmailContent;
  }) => {
    sent.push(message);
    return { sent: true, logged: false };
  },
}));

/**
 * Password recovery, and the frame its email is sent in.
 *
 * The token machinery in lib/password-reset.ts needs a database, so what is
 * covered here is everything that does not: the rules the forms and the API
 * share, and the rendering of the message itself - which matters because a
 * reset link that does not survive into the plain-text part is a reset
 * nobody can complete from a mail client that refuses HTML.
 */

describe("forgotPasswordSchema", () => {
  it("wants a real address and nothing else", () => {
    expect(forgotPasswordSchema.safeParse({ email: "owner@shop.com" }).success).toBe(
      true,
    );
    expect(forgotPasswordSchema.safeParse({ email: "not-an-email" }).success).toBe(
      false,
    );
    expect(forgotPasswordSchema.safeParse({ email: "" }).success).toBe(false);
  });

  it("normalises what people type", () => {
    const parsed = forgotPasswordSchema.parse({ email: "  Owner@Shop.COM " });
    expect(parsed.email).toBe("owner@shop.com");
  });
});

describe("resetPasswordSchema", () => {
  const good = { token: "abc", password: "sunflower9", confirm: "sunflower9" };

  it("accepts a matching pair", () => {
    expect(resetPasswordSchema.safeParse(good).success).toBe(true);
  });

  it("refuses a mismatch, and says which field is wrong", () => {
    const parsed = resetPasswordSchema.safeParse({ ...good, confirm: "sunflower8" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["confirm"]);
    }
  });

  it("holds the new password to the same floor an account is opened with", () => {
    // Otherwise a reset would be a way under the rule the platform sets.
    expect(resetPasswordSchema.safeParse({ ...good, password: "short7", confirm: "short7" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ ...good, password: "exactly8", confirm: "exactly8" }).success).toBe(true);
  });

  it("refuses a link with no token", () => {
    expect(resetPasswordSchema.safeParse({ ...good, token: "" }).success).toBe(false);
    expect(resetPasswordSchema.safeParse({ ...good, token: "   " }).success).toBe(false);
  });
});

describe("the email frame", () => {
  const content: EmailContent = {
    heading: "Sun & Moon Pharmacy is ready",
    intro: ["Hello Sita,", "An account has been opened."],
    blocks: [
      {
        label: "Your sign-in details",
        rows: [
          { name: "Email", value: "owner@sun-moon.com" },
          { name: "Password", value: "Temp@1234" },
        ],
      },
      { caution: "Change this password once you are in." },
    ],
    button: { label: "Sign in", url: "https://example.test/login" },
    outro: ["If the button does not work, open https://example.test/login"],
  };

  it("escapes text that would otherwise break the markup", () => {
    expect(escapeHtml(`Sun & Moon <b>"x"</b>`)).toBe(
      "Sun &amp; Moon &lt;b&gt;&quot;x&quot;&lt;/b&gt;",
    );
    // A shop really can be called this, and an unescaped & is a broken entity.
    expect(renderEmail(content)).toContain("Sun &amp; Moon Pharmacy is ready");
    expect(renderEmail(content)).not.toContain("Sun & Moon Pharmacy is ready");
  });

  it("carries the credentials and the link in the HTML part", () => {
    const html = renderEmail(content);
    expect(html).toContain("owner@sun-moon.com");
    expect(html).toContain("Temp@1234");
    expect(html).toContain("https://example.test/login");
  });

  it("carries them in the plain-text part too", () => {
    // A message with no usable text part is one a strict client cannot act on,
    // and is markedly more likely to be scored as spam.
    const text = renderEmailText(content);
    expect(text).toContain("owner@sun-moon.com");
    expect(text).toContain("Temp@1234");
    expect(text).toContain("https://example.test/login");
    expect(text).toContain("MantraMed");
    // Plain text, so entities must not leak into it.
    expect(text).toContain("Sun & Moon Pharmacy is ready");
    expect(text).not.toContain("&amp;");
  });

  it("wears the company frame on every message", () => {
    const html = renderEmail(content);
    expect(html).toContain("MantraMed");
    expect(html).toContain("Pharmacy Suite");
    expect(html).toContain("MantraSphere Innovations Pvt. Ltd.");
    // Table layout and inline styles, because a mail client cannot read a
    // stylesheet and Outlook renders through Word.
    expect(html).toContain("<table");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("class=");
  });

  it("renders a message with no blocks or button", () => {
    const bare = renderEmail({ heading: "Hello", intro: ["Just a note."] });
    expect(bare).toContain("Just a note.");
    expect(renderEmailText({ heading: "Hello", intro: ["Just a note."] })).toContain(
      "Just a note.",
    );
  });
});

/**
 * The RFC 822 message posted to the Gmail API.
 *
 * Worth testing because it is hand-built rather than produced by a library:
 * a mail client will not tell you the boundary was wrong, it will just show
 * the raw parts, and a header carrying Devanagari unencoded is either
 * mojibake or a rejected message.
 */
describe("buildMimeMessage", () => {
  const base = {
    from: "MantraMed <no-reply@example.com>",
    to: "owner@shop.com",
    subject: "Your MantraMed account",
    text: "plain body",
    html: "<p>rich body</p>",
  };

  it("declares multipart/alternative and closes the boundary", () => {
    const raw = buildMimeMessage(base);
    const boundary = raw.match(/boundary="([^"]+)"/)?.[1];
    expect(boundary).toBeTruthy();
    // Opened twice, once per part, and closed with the trailing --.
    expect(raw.split(`--${boundary}\r\n`)).toHaveLength(3);
    expect(raw).toContain(`--${boundary}--`);
  });

  it("puts the plain-text part before the HTML one", () => {
    // The order is what tells a client the HTML is the richer version of the
    // same message rather than something separate.
    const raw = buildMimeMessage(base);
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));
  });

  it("carries both bodies, base64 encoded", () => {
    const raw = buildMimeMessage(base);
    expect(raw).toContain(Buffer.from("plain body", "utf8").toString("base64"));
    expect(raw).toContain(Buffer.from("<p>rich body</p>", "utf8").toString("base64"));
  });

  it("uses CRLF line endings throughout", () => {
    // Bare LF in a message is the classic way a strict server rejects it.
    const raw = buildMimeMessage(base);
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("leaves an ASCII subject alone", () => {
    expect(buildMimeMessage(base)).toContain("Subject: Your MantraMed account");
  });

  it("encodes a subject that is not ASCII", () => {
    const raw = buildMimeMessage({ ...base, subject: "कर बीजक तयार छ" });
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).not.toContain("Subject: कर बीजक तयार छ");
  });

  it("carries a Date, a Message-ID on the From domain and auto-reply guards", () => {
    const raw = buildMimeMessage(base);
    expect(raw).toMatch(/\r\nDate: .+\+0000\r\n/);
    expect(raw).toMatch(/\r\nMessage-ID: <[^@>]+@example\.com>\r\n/);
    expect(raw).toContain("Auto-Submitted: auto-generated");
  });

  it("wraps an inline image in multipart/related with its Content-ID", () => {
    const raw = buildMimeMessage({
      ...base,
      html: '<img src="cid:logo@mantramed">',
      inline: [
        {
          cid: "logo@mantramed",
          filename: "logo.png",
          contentType: "image/png",
          content: Buffer.from("png-bytes"),
        },
      ],
    });
    const related = raw.match(/multipart\/related; boundary="([^"]+)"/)?.[1];
    expect(related).toBeTruthy();
    // Opened for the alternative part and the image, then closed.
    expect(raw.split(`--${related}\r\n`)).toHaveLength(3);
    expect(raw).toContain(`--${related}--`);
    expect(raw).toContain("Content-ID: <logo@mantramed>");
    expect(raw).toContain("Content-Disposition: inline");
    expect(raw.indexOf("text/html")).toBeLessThan(raw.indexOf("image/png"));
    expect(raw.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("includes Reply-To only when there is one", () => {
    expect(buildMimeMessage(base)).not.toContain("Reply-To:");
    expect(
      buildMimeMessage({ ...base, replyTo: "support@example.com" }),
    ).toContain("Reply-To: support@example.com");
  });
});

/**
 * The confirmation sent once a reset has actually gone through.
 *
 * Worth pinning down rather than leaving to review: this is the message an
 * owner reads when somebody *else* reset their password, and the one thing it
 * must never do - carry a credential - is exactly what a later edit could add
 * by copying a neighbouring message in that file.
 */
describe("sendPasswordChangedEmail", () => {
  async function capture() {
    sent.length = 0;
    await sendPasswordChangedEmail({ to: "owner@shop.com", name: "Sita" });
    const message = sent.at(-1);
    if (!message) throw new Error("nothing was sent");
    return message;
  }

  it("goes to the account address, and says what happened", async () => {
    const message = await capture();
    expect(message.to).toBe("owner@shop.com");
    expect(message.subject).toMatch(/password has been changed/i);
    expect(message.content.heading).toMatch(/password has been changed/i);
    expect(renderEmailText(message.content)).toContain("Hello Sita,");
  });

  it("carries no credential panel", async () => {
    // The whole point of the message. There is nothing to include even if it
    // were wise - what was just stored is a bcrypt hash - and a confirmation
    // is the last mail that should leave a password sitting in a mailbox.
    const message = await capture();
    expect(message.content.blocks ?? []).toHaveLength(0);
    // The monospaced face is only used by the name/value panel, so its
    // absence is how "no panel was rendered" reads in the HTML.
    expect(renderEmail(message.content)).not.toContain("Courier New");
  });

  it("offers a way back in", async () => {
    // Somebody who has just reset a password is signed in nowhere.
    const message = await capture();
    expect(message.content.button?.url).toBe(`${config.appUrl}/login`);
    // And in the text part too, for a client that will not render a button.
    expect(renderEmailText(message.content)).toContain(`${config.appUrl}/login`);
  });

  it("tells the person who did not do this what to do", async () => {
    const text = renderEmailText((await capture()).content);
    expect(text).toMatch(/if you did not do this/i);
  });
});
