/**
 * The bot's self-description, in one place. Four surfaces used to each carry
 * their own drifting copy (welcome message, unknown-command reply, assistant
 * fallback, and nothing at all for /help), so they all read from here now.
 *
 * Plain text on purpose: no reply in this bot sets parse_mode, so nothing here
 * needs Markdown/HTML escaping and Thai merchant names can't break formatting.
 */

/** One-liner tail for places that just need to point at the full text. */
export const SHORT_USAGE =
  "📸 Send me a photo of a banking slip (add a caption saying what it was for) and I'll log it.\n" +
  "📊 /dashboard — this month's summary\n" +
  "❓ /help — everything I can do";

/** The full /help message. Well under Telegram's 4096-character limit. */
export const HELP_TEXT = [
  "🧾 Spending AI — what I can do",
  "",
  "📸 Send a slip photo",
  "Add a caption saying what it was for and I'll save it right away. No caption? I'll ask \"what was this for?\" — just reply with a few words.",
  "",
  "📚 Send several at once",
  "Pick multiple slips in one go and I'll read them all together, then show a summary plus a card for each. One note covers the whole lot — tap 📝 Different note for each if they were separate things.",
  "",
  "✏️ Fix an entry",
  "Every saved card has buttons: tap a category to correct it, or 🗑 to delete it.",
  "/undo — remove the entry you just logged",
  "",
  "✂️ Split a bill",
  "Tap ✂️ Split on any card:",
  "• 👥 Between people — you paid for the group, keep only your share",
  "• 🗓 Across months — one payment spread over N months",
  "↩️ Undo split puts it back.",
  "",
  "📊 See your spending",
  "/dashboard — this month: total, categories, top merchants",
  "/dashboard 2026-06 — any past month",
  "Every day at 5 AM I send yesterday's summary.",
  "",
  "💬 Just ask me",
  '"how much on food this month?"',
  '"change my last slip to Transport"',
  "I'll answer, or show a confirm button before changing anything.",
].join("\n");
