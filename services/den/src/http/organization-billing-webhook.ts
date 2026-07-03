import express from "express"
import Stripe from "stripe"
import type { OrganizationBillingRepository } from "../billing/repository.js"
import type { StripeOrganizationBillingConfig } from "../billing/stripe-config.js"
import {
  createStripeOrganizationBillingWebhookProcessor,
  type StripeOrganizationBillingEvent,
  type StripeOrganizationBillingWebhookProcessor,
} from "../billing/stripe-webhooks.js"

export type VerifyStripeOrganizationBillingEvent = (
  payload: Buffer,
  signature: string,
  webhookSecret: string,
) => unknown

export type CreateOrganizationBillingWebhookRouterInput = {
  config: StripeOrganizationBillingConfig
  repository?: OrganizationBillingRepository
  processor?: StripeOrganizationBillingWebhookProcessor
  verifyEvent?: VerifyStripeOrganizationBillingEvent
}

const WEBHOOK_PATH = "/v1/organization-billing/stripe/webhook"

export function createOrganizationBillingWebhookRouter(
  input: CreateOrganizationBillingWebhookRouterInput,
) {
  const router = express.Router()
  const verifyEvent = input.verifyEvent ?? createDefaultStripeEventVerifier(input.config)
  const processor = input.processor ?? createDefaultProcessor(input)

  router.post(WEBHOOK_PATH, express.raw({ type: "application/json" }), async (req, res) => {
    if (!input.config.enabled || !input.config.webhookSecret) {
      res.status(503).json({ error: "stripe_billing_webhook_disabled" })
      return
    }
    if (!processor) {
      res.status(503).json({ error: "stripe_billing_webhook_unavailable" })
      return
    }

    const signature = req.header("stripe-signature")
    if (!signature) {
      res.status(400).json({ error: "missing_stripe_signature" })
      return
    }

    let event: StripeOrganizationBillingEvent
    try {
      if (!Buffer.isBuffer(req.body)) {
        throw new Error("Stripe webhook body must be raw bytes")
      }
      event = verifyEvent(req.body, signature, input.config.webhookSecret) as StripeOrganizationBillingEvent
    } catch {
      res.status(400).json({ error: "invalid_stripe_signature" })
      return
    }

    const result = await processor.processEvent(event)
    if (!result.ok) {
      res.status(500).json({ ok: false, status: result.status, error: result.errorMessage ?? "webhook_failed" })
      return
    }

    res.json({ ok: true, status: result.status })
  })

  return router
}

function createDefaultStripeEventVerifier(config: StripeOrganizationBillingConfig): VerifyStripeOrganizationBillingEvent {
  return (payload, signature, webhookSecret) => {
    if (!config.enabled || !config.secretKey) {
      throw new Error("Stripe organization billing is disabled")
    }
    const stripe = new Stripe(config.secretKey, {
      apiVersion: Stripe.API_VERSION,
    })
    return stripe.webhooks.constructEvent(payload.toString("utf8"), signature, webhookSecret)
  }
}

function createDefaultProcessor(input: CreateOrganizationBillingWebhookRouterInput) {
  if (!input.repository) {
    return null
  }

  return createStripeOrganizationBillingWebhookProcessor({
    config: input.config,
    repository: input.repository,
  })
}
