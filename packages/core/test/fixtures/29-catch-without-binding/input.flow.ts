import type { Tools } from "../generated/tools";

export default async function flow(input: { amount: number }, tools: Tools) {
  try {
    await tools.payment.charge({ amount: input.amount });
  } catch {
    await tools.slack.send({ channel: "#alerts", message: "charge failed" });
  }

  await tools.audit.log({ item: input.amount });
}
