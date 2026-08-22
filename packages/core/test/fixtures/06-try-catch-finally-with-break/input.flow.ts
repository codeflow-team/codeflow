import type { Tools } from "../generated/tools";

export default async function flow(input: { amounts: number[] }, tools: Tools) {
  for (const amount of input.amounts) {
    try {
      await tools.payment.charge({ amount });
    } catch (err) {
      await tools.slack.send({ channel: "#alerts", message: `Charge failed: ${err}` });
      break;
    } finally {
      await tools.audit.log({ item: amount });
    }
  }
}
