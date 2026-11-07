// Proves the AI client works. Run: npm run ai:check
import { z } from "zod";
import { generateJson } from "./ai.js";

const out = await generateJson(z.object({ reason_code: z.enum(["INR", "SNAD", "UNAUTHORIZED", "DUPLICATE", "SUBSCRIPTION_CANCEL"]) }),
  "Classify the complaint.", "I think I was charged twice this month");
console.log(out); // expect { reason_code: "DUPLICATE" }
