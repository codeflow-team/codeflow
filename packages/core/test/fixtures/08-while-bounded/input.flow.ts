import type { Tools } from "../generated/tools";

export default async function flow(input: { amount: number }, tools: Tools) {
  let attempts = 0;

  while (attempts < 3) {
    await tools.payment.charge({ amount: input.amount });
    attempts++;
  }
}
