import { Effect, Exit, Fiber, Layer, ManagedRuntime, Scope } from "effect"
import * as Context from "effect/Context"
import { InstanceRef, WorkspaceRef } from "./instance-ref"
import * as Observability from "@opencode-ai/core/observability"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import type { InstanceContext } from "@/project/instance-context"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import { lazy } from "../util/lazy"

type Refs = {
  instance?: InstanceContext
  workspace?: string
}

export function attachWith<A, E, R>(effect: Effect.Effect<A, E, R>, refs: Refs): Effect.Effect<A, E, R> {
  if (!refs.instance && !refs.workspace) return effect
  if (!refs.instance) return effect.pipe(Effect.provideService(WorkspaceRef, refs.workspace))
  if (!refs.workspace) return effect.pipe(Effect.provideService(InstanceRef, refs.instance))
  return effect.pipe(
    Effect.provideService(InstanceRef, refs.instance),
    Effect.provideService(WorkspaceRef, refs.workspace),
  )
}

export function attach<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const workspace = WorkspaceContext.workspaceID
  const fiber = Fiber.getCurrent()
  return attachWith(effect, {
    instance: fiber ? Context.getReferenceUnsafe(fiber.context, InstanceRef) : undefined,
    workspace: workspace ?? (fiber ? Context.getReferenceUnsafe(fiber.context, WorkspaceRef) : undefined),
  })
}

export const serviceScope = Scope.makeUnsafe("parallel")

export function makeRuntime<I, S, E>(service: Context.Service<I, S>, layer: Layer.Layer<I, E>) {
  const get = lazy(() => {
    const owner = Scope.forkUnsafe(serviceScope)
    const rt = ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer), { memoMap })
    Effect.runSync(Scope.addFinalizer(owner, rt.disposeEffect))
    return { rt, owner }
  })

  return {
    context: () => get().rt.context(),
    dispose: () => Effect.runPromise(Scope.close(get().owner, Exit.void)),
    runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => get().rt.runSync(attach(service.use(fn))),
    runPromiseExit: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      get().rt.runPromiseExit(attach(service.use(fn)), options),
    runPromise: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>, options?: Effect.RunOptions) =>
      get().rt.runPromise(attach(service.use(fn)), options),
    runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => get().rt.runFork(attach(service.use(fn))),
    runCallback: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) =>
      get().rt.runCallback(attach(service.use(fn))),
  }
}
