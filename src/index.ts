import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { PayinRequestSchema } from "./connect/payin.js";
import { StatusRequestSchema } from "./connect/status.js";
import type { GwConnectError } from "./connect/error.js";
import { zValidator } from "./validator_wrapper.js";
import { createJwt } from "./connect/callback.js";
import { InteractionLogs } from "./interaction_logs.js";
import { requireEnv } from "./env.js";
import assert from "assert";

export const BusinessUrl = requireEnv("BUSINESS_URL");
export const SignKey = requireEnv("SIGN_KEY");
export const Port = parseInt(requireEnv("PORT"));
if (Number.isNaN(Port)) {
  throw Error(`Invalid port number value`);
}

const app = new Hono();

app.use(logger());
app.use(async (c, next) => {
  try {
    console.log(
      "Gateway connect request body:",
      JSON.stringify(await c.req.json()),
    );
  } catch {}
  await next();
});

// We store payment in memory for simplitity sake
type StoredPayment = {
  amount: number;
  privateKey: string;
  currency: string;
  token: string;
};
let storedPayment: StoredPayment | undefined = undefined;

app
  .post("/pay", zValidator("json", PayinRequestSchema), async (c) => {
    let payRequest = c.req.valid("json");

    let interaction_logs = new InteractionLogs();
    let span = interaction_logs.span("pay");

    storedPayment = {
      amount: payRequest.payment.gateway_amount,
      privateKey: payRequest.payment.merchant_private_key,
      currency: payRequest.payment.gateway_currency,
      token: payRequest.payment.token,
    };

    try {
      // make gateway request
      let response = {
        status: "pending",
        redirect_request: {
          type: "get_with_processing",
          url: "https://www.google.com/search?q=payment",
        },
        logs: interaction_logs.build(),
        gateway_token: "12345",
        result: true,
      };

      console.log(response);
      return c.json(response);
    } catch {
      return c.json({
        result: false,
        error: "Gateway Connect error, please check logs for more details",
        logs: interaction_logs.build(),
      } as GwConnectError);
    }
  })
  .post("/status", zValidator("json", StatusRequestSchema), async (c) => {
    assert(storedPayment, "payment should exist when status is called");
    let statusRequest = c.req.valid("json");
    let interaction_logs = new InteractionLogs();
    interaction_logs.span("status");
    // here we send status request to external gateway
    // Reactivepay Status request will contain gateway id of transaction statusRequest.payment.gateway_token
    return c.json({
      status: "pending",
      amount: storedPayment.amount * 100,
      currency: storedPayment.currency,
      result: true,
      logs: interaction_logs.build(),
    });
  })
  .post("/gateway/callback", async (c) => {
    assert(storedPayment, "payment should exist when callback is called");
    let interactionLogs = new InteractionLogs();
    let span = interactionLogs.span("callback");
    span.set_request(
      "https://gateway.connect.url",
      await c.req.json().catch(() => ({})),
    );
    span.set_response_status(200);
    let url =
      BusinessUrl + `/callbacks/v2/gateway_callbacks/${storedPayment.token}`;
    let status = "approved";
    let rpPayload = {
      status,
      reason: status === "declined" ? "error message" : undefined,
      currency: storedPayment.currency,
      amount: storedPayment.amount,
      logs: interactionLogs.build(),
    };
    let jwt = await createJwt(
      rpPayload,
      storedPayment.privateKey,
      Buffer.from(SignKey),
    );

    try {
      let body = JSON.stringify(rpPayload);
      console.log("Sending callback to Gateway Connect", url, body);

      let res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${jwt}`,
        },
        body,
      });
      console.log(`Gateway connect callback response status: ${res.status}`);
      if (!res.ok) {
        throw Error(`bad response status code: ${res.status}`);
      }
      return c.body(null, 200);
    } catch (e) {
      console.log("Failed to send callback to RP", e);
      return c.json({ message: "Failed to process callback" }, 500);
    }
  });

serve(
  {
    fetch: app.fetch,
    port: Port,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
