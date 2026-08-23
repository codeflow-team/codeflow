import type { Tools } from "../generated/tools";

export default async function flow(input: { amount: number }, tools: Tools) {
  try {
    const charge = await tools.payment.charge({ amount: input.amount });
    if (charge.status === "pending") {
      return charge;
    }
  } catch (err) {
    await tools.slack.send({
      channel: "#alerts",
      message: `Charge failed: ${err}`
    });
  }

  return null;
}
