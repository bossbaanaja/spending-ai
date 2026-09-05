// Typhoon OCR (SCB 10X) — a model built specifically for reading Thai
// documents. It returns the slip's text as markdown; it does NOT extract
// structured fields, so slipParser.ts feeds its output to the NIM model
// for the JSON step. API is OpenAI-compatible: https://github.com/scb-10x/typhoon-ocr

// The official "v1.5" prompt from the typhoon-ocr package, verbatim — the
// model is trained against this exact wording.
const OCR_PROMPT = `Extract all text from the image.


Instructions:
- Only return the clean Markdown.
- Do not include any explanation or extra text.
- You must include all information on the page.


Formatting Rules:
- Tables: Render tables using <table>...</table> in clean HTML format.
- Equations: Render equations using LaTeX syntax with inline ($...$) and block ($$...$$).
- Images/Charts/Diagrams: Wrap any clearly defined visual areas (e.g. charts, diagrams, pictures) in:


<figure>
Describe the image's main elements (people, objects, text), note any contextual clues (place, event, culture), mention visible text and its meaning, provide deeper analysis when relevant (especially for financial charts, graphs, or documents), comment on style or architecture if relevant, then give a concise overall summary. Describe in Thai.
</figure>


- Page Numbers: Wrap page numbers in <page_number>...</page_number> (e.g., <page_number>14</page_number>).
- Checkboxes: Use ☐ for unchecked and ☑ for checked boxes.
    `;

/**
 * OCRs one slip image into markdown text. Same 4-attempt retry shape as the
 * NIM calls — a hosted endpoint returning an occasional empty completion is
 * cheap to guard against everywhere.
 */
export async function typhoonOcrImage(imageBase64: string, env: Env, deadline?: number): Promise<string> {
  let lastError: unknown;
  // Same total-time cap idea as nim.ts — fail with a message, not a stuck bubble.
  const started = Date.now();
  let retryDelay = 300;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0 && Date.now() - started > 40_000) break;
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryDelay));
    // Clamp the attempt to what the deadline leaves — same rule as nim.ts.
    const attemptTimeout = deadline ? Math.min(30_000, deadline - Date.now() - 2_000) : 30_000;
    if (attemptTimeout < 3_000) break;
    const attemptStarted = Date.now();
    try {
      const res = await fetch("https://api.opentyphoon.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TYPHOON_OCR_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "typhoon-ocr",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: OCR_PROMPT },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
              ],
            },
          ],
          max_tokens: 4096,
          // Typhoon's own recommended decoding settings for the v1.5 task.
          temperature: 0.1,
          top_p: 0.6,
          repetition_penalty: 1.1,
        }),
        // Measured ~8s per slip; capped so a stall leaves time for the NIM
        // stage within the update's ~55s lifetime (see index.ts).
        signal: AbortSignal.timeout(attemptTimeout),
      });
      if (!res.ok) {
        throw new Error(`Typhoon OCR API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("Typhoon OCR response had no content");
      console.error(JSON.stringify({ event: "typhoon_ocr_attempt_ok", attempt, ms: Date.now() - attemptStarted }));
      return content;
    } catch (err) {
      lastError = err;
      // Typhoon has one model, so unlike nim.ts there is no other queue to
      // rotate to — a 429 (its concurrency cap is ~3 per key, measured
      // 2026-08-26) needs a real pause for an in-flight slip (~8s) to free a
      // slot; 300ms retries all land inside the same busy window.
      retryDelay = String(err).includes("Typhoon OCR API 429") ? 4_000 : 300;
      console.error(JSON.stringify({ event: "typhoon_ocr_attempt_failed", attempt, error: String(err) }));
    }
  }
  throw new Error(`Typhoon OCR failed: ${String(lastError ?? "no time left before the deadline")}`);
}
