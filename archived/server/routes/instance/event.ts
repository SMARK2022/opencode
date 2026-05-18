import z from "zod"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import * as Log from "@opencode-ai/core/util/log"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { streamEventSource } from "@/server/event"

const log = Log.create({ service: "server" })

export const EventRoutes = () =>
  new Hono().get(
    "/event",
    describeRoute({
      summary: "Subscribe to events",
      description: "Get events",
      operationId: "event.subscribe",
      responses: {
        200: {
          description: "Event stream",
          content: {
            "text/event-stream": {
              schema: resolver(
                z.union(BusEvent.payloads()).meta({
                  ref: "Event",
                }),
              ),
            },
          },
        },
      },
    }),
    async (c) => {
      log.info("event connected")

      return streamEventSource(c, {
        initial: [
          JSON.stringify({
            id: Bus.createID(),
            type: "server.connected",
            properties: {},
          }),
        ],
        heartbeat: () =>
          JSON.stringify({
            id: Bus.createID(),
            type: "server.heartbeat",
            properties: {},
          }),
        subscribe: (q) => {
          const unsub = Bus.subscribeAll((event) => {
            q.push(JSON.stringify(event))

            // Instance disposal is terminal for this stream; enqueueing null lets
            // the shared SSE helper close the connection through the normal path.
            if (event.type === Bus.InstanceDisposed.type) q.push(null)
          })

          return () => {
            unsub()
            log.info("event disconnected")
          }
        },
      })
    },
  )
