import type { Tools } from "../generated/tools";
import { isReady } from "@flows/lib";

export default async function flow(input: { amount: number }, tools: Tools) {
  const [charge, receipt, ready] = await Promise.all([
    tools.payment.charge({ amount: input.amount }),
    tools.payment.receipt({ amount: input.amount }),
    isReady(input)
  ]);

  await tools.slack.send({
    channel: "#billing",
    message: `${charge} ${receipt} ${ready}`
  });
}
