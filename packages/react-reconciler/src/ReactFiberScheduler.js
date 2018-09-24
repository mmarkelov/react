/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {Batch, FiberRoot} from './ReactFiberRoot';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {Interaction} from 'scheduler/src/Tracing';
import type {CapturedValue} from './ReactCapturedValue';
import type {Instance} from './ReactFiberHostConfig';

import {__interactionsRef, __subscriberRef} from 'scheduler/tracing';
import {
  invokeGuardedCallback,
  hasCaughtError,
  clearCaughtError,
} from 'shared/ReactErrorUtils';
import ReactSharedInternals from 'shared/ReactSharedInternals';
import ReactStrictModeWarnings from './ReactStrictModeWarnings';
import {
  NoEffect,
  PerformedWork,
  Placement,
  Update,
  Snapshot,
  PlacementAndUpdate,
  Deletion,
  ContentReset,
  Callback,
  DidCapture,
  Ref,
  Incomplete,
  HostEffectMask,
  Update as UpdateEffect,
  LifecycleEffectMask,
  ShouldCapture,
} from 'shared/ReactSideEffectTags';
import {
  HostRoot,
  ClassComponent,
  ClassComponentLazy,
  HostComponent,
  ContextProvider,
  HostPortal,
  PlaceholderComponent,
  IndeterminateComponent,
  FunctionalComponent,
  HostText,
  Profiler,
} from 'shared/ReactWorkTags';
import {
  enableSchedulerTracing,
  enableProfilerTimer,
  enableUserTimingAPI,
  replayFailedUnitOfWorkWithInvokeGuardedCallback,
  warnAboutDeprecatedLifecycles,
  warnAboutLegacyContextAPI,
  enableSuspense,
  enableGetDerivedStateFromCatch,
} from 'shared/ReactFeatureFlags';
import getComponentName from 'shared/getComponentName';
import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';
import {getResultFromResolvedThenable} from 'shared/ReactLazyComponent';

import {
  scheduleTimeout,
  cancelTimeout,
  noTimeout,
  getPublicInstance,
  commitMount,
  supportsMutation,
  supportsPersistence,
  removeChildFromContainer,
  removeChild,
} from './ReactFiberHostConfig';

import ReactFiberInstrumentation from './ReactFiberInstrumentation';
import * as ReactCurrentFiber from './ReactCurrentFiber';
import {
  now,
  scheduleDeferredCallback,
  cancelDeferredCallback,
  prepareForCommit,
  resetAfterCommit,
} from './ReactFiberHostConfig';
import {
  markPendingPriorityLevel,
  markCommittedPriorityLevels,
  markSuspendedPriorityLevel,
  markPingedPriorityLevel,
  hasLowerPriorityWork,
  isPriorityLevelSuspended,
  findEarliestOutstandingPriorityLevel,
  didExpireAtExpirationTime,
} from './ReactFiberPendingPriority';
import {
  recordEffect,
  recordScheduleUpdate,
  startRequestCallbackTimer,
  stopRequestCallbackTimer,
  startWorkTimer,
  stopWorkTimer,
  stopFailedWorkTimer,
  startWorkLoopTimer,
  stopWorkLoopTimer,
  startCommitTimer,
  stopCommitTimer,
  startCommitSnapshotEffectsTimer,
  stopCommitSnapshotEffectsTimer,
  startCommitHostEffectsTimer,
  stopCommitHostEffectsTimer,
  startCommitLifeCyclesTimer,
  stopCommitLifeCyclesTimer,
  startPhaseTimer,
  stopPhaseTimer,
} from './ReactDebugFiberPerf';
import {createWorkInProgress, assignFiberPropertiesInDEV} from './ReactFiber';
import {onCommitRoot, onCommitUnmount} from './ReactFiberDevToolsHook';
import {
  NoWork,
  Sync,
  Never,
  msToExpirationTime,
  expirationTimeToMs,
  computeAsyncExpiration,
  computeInteractiveExpiration,
  LOW_PRIORITY_EXPIRATION,
} from './ReactFiberExpirationTime';
import {AsyncMode, ProfileMode, StrictMode} from './ReactTypeOfMode';
import {
  CaptureUpdate,
  commitUpdateQueue,
  createUpdate,
  enqueueCapturedUpdate,
  enqueueUpdate,
  resetCurrentlyProcessingQueue,
} from './ReactUpdateQueue';
import {createCapturedValue} from './ReactCapturedValue';
import {
  isContextProvider as isLegacyContextProvider,
  popTopLevelContextObject as popTopLevelLegacyContextObject,
  popContext as popLegacyContext,
} from './ReactFiberContext';
import {popProvider, resetContextDependences} from './ReactFiberNewContext';
import {popHostContext, popHostContainer} from './ReactFiberHostContext';
import {
  getCommitTime,
  recordCommitTime,
  startProfilerTimer,
  stopProfilerTimerIfRunningAndRecordDelta,
} from './ReactProfilerTimer';
import {
  checkThatStackIsEmpty,
  resetStackAfterFatalErrorInDev,
} from './ReactFiberStack';
import {
  NoopComponent,
  unwindWork,
  unwindInterruptedWork,
} from './ReactFiberUnwindWork';
import {beginWork, reconcileChildren} from './ReactFiberBeginWork';
import {completeWork} from './ReactFiberCompleteWork';
import {
  commitBeforeMutationLifeCycles,
  commitResetTextContent,
  commitPlacement,
  commitWork,
  commitAttachRef,
  commitDetachRef,
  logError,
  callComponentWillUnmountWithTimer,
  detachFiber,
  emptyPortalContainer,
} from './ReactFiberCommitWork';
import {Dispatcher} from './ReactFiberDispatcher';
import maxSigned31BitInt from './maxSigned31BitInt';

export type Deadline = {
  timeRemaining(): number,
  didTimeout: boolean,
};

export type Thenable = {
  then(resolve: () => mixed, reject?: () => mixed): mixed,
};

const {ReactCurrentOwner} = ReactSharedInternals;
const emptyObject = {};

let didWarnAboutStateTransition;
let didWarnSetStateChildContext;
let warnAboutUpdateOnUnmounted;
let warnAboutInvalidUpdates;

if (enableSchedulerTracing) {
  // Provide explicit error message when production+profiling bundle of e.g. react-dom
  // is used with production (non-profiling) bundle of schedule/tracing
  invariant(
    __interactionsRef != null && __interactionsRef.current != null,
    'It is not supported to run the profiling version of a renderer (for example, `react-dom/profiling`) ' +
      'without also replacing the `schedule/tracing` module with `schedule/tracing-profiling`. ' +
      'Your bundler might have a setting for aliasing both modules. ' +
      'Learn more at http://fb.me/react-profiling',
  );
}

if (__DEV__) {
  didWarnAboutStateTransition = false;
  didWarnSetStateChildContext = false;
  const didWarnStateUpdateForUnmountedComponent = {};

  warnAboutUpdateOnUnmounted = function(fiber: Fiber) {
    // We show the whole stack but dedupe on the top component's name because
    // the problematic code almost always lies inside that component.
    const componentName = getComponentName(fiber.type) || 'ReactClass';
    if (didWarnStateUpdateForUnmountedComponent[componentName]) {
      return;
    }
    warningWithoutStack(
      false,
      "Can't call setState (or forceUpdate) on an unmounted component. This " +
        'is a no-op, but it indicates a memory leak in your application. To ' +
        'fix, cancel all subscriptions and asynchronous tasks in the ' +
        'componentWillUnmount method.%s',
      ReactCurrentFiber.getStackByFiberInDevAndProd(fiber),
    );
    didWarnStateUpdateForUnmountedComponent[componentName] = true;
  };

  warnAboutInvalidUpdates = function(instance: React$Component<any>) {
    switch (ReactCurrentFiber.phase) {
      case 'getChildContext':
        if (didWarnSetStateChildContext) {
          return;
        }
        warningWithoutStack(
          false,
          'setState(...): Cannot call setState() inside getChildContext()',
        );
        didWarnSetStateChildContext = true;
        break;
      case 'render':
        if (didWarnAboutStateTransition) {
          return;
        }
        warningWithoutStack(
          false,
          'Cannot update during an existing state transition (such as within ' +
            '`render`). Render methods should be a pure function of props and state.',
        );
        didWarnAboutStateTransition = true;
        break;
    }
  };
}

// Used to ensure computeUniqueAsyncExpiration is monotonically increasing.
let lastUniqueAsyncExpiration: number = 0;

// Represents the expiration time that incoming updates should use. (If this
// is NoWork, use the default strategy: async updates in async mode, sync
// updates in sync mode.)
let expirationContext: ExpirationTime = NoWork;

let isWorking: boolean = false;

// The next work in progress fiber that we're currently working on.
let nextUnitOfWork: Fiber | null = null;
let nextRoot: FiberRoot | null = null;
// The time at which we're currently rendering work.
let nextRenderExpirationTime: ExpirationTime = NoWork;
let nextLatestAbsoluteTimeoutMs: number = -1;
let nextRenderDidError: boolean = false;

// The next fiber with an effect that we're currently committing.
let nextEffect: Fiber | null = null;

let isCommitting: boolean = false;

let legacyErrorBoundariesThatAlreadyFailed: Set<mixed> | null = null;

// Used for performance tracking.
let interruptedBy: Fiber | null = null;

// Do not decrement interaction counts in the event of suspense timeouts.
// This would lead to prematurely calling the interaction-complete hook.
let suspenseDidTimeout: boolean = false;

let stashedWorkInProgressProperties;
let replayUnitOfWork;
let isReplayingFailedUnitOfWork;
let originalReplayError;
let rethrowOriginalError;
if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
  stashedWorkInProgressProperties = null;
  isReplayingFailedUnitOfWork = false;
  originalReplayError = null;
  replayUnitOfWork = (
    failedUnitOfWork: Fiber,
    thrownValue: mixed,
    isYieldy: boolean,
  ) => {
    if (
      thrownValue !== null &&
      typeof thrownValue === 'object' &&
      typeof thrownValue.then === 'function'
    ) {
      // Don't replay promises. Treat everything else like an error.
      // TODO: Need to figure out a different strategy if/when we add
      // support for catching other types.
      return;
    }

    // Restore the original state of the work-in-progress
    if (stashedWorkInProgressProperties === null) {
      // This should never happen. Don't throw because this code is DEV-only.
      warningWithoutStack(
        false,
        'Could not replay rendering after an error. This is likely a bug in React. ' +
          'Please file an issue.',
      );
      return;
    }
    assignFiberPropertiesInDEV(
      failedUnitOfWork,
      stashedWorkInProgressProperties,
    );

    switch (failedUnitOfWork.tag) {
      case HostRoot:
        popHostContainer(failedUnitOfWork);
        popTopLevelLegacyContextObject(failedUnitOfWork);
        break;
      case HostComponent:
        popHostContext(failedUnitOfWork);
        break;
      case ClassComponent: {
        const Component = failedUnitOfWork.type;
        if (isLegacyContextProvider(Component)) {
          popLegacyContext(failedUnitOfWork);
        }
        break;
      }
      case ClassComponentLazy: {
        const Component = getResultFromResolvedThenable(failedUnitOfWork.type);
        if (isLegacyContextProvider(Component)) {
          popLegacyContext(failedUnitOfWork);
        }
        break;
      }
      case HostPortal:
        popHostContainer(failedUnitOfWork);
        break;
      case ContextProvider:
        popProvider(failedUnitOfWork);
        break;
    }
    // Replay the begin phase.
    isReplayingFailedUnitOfWork = true;
    originalReplayError = thrownValue;
    invokeGuardedCallback(null, workLoop, null, isYieldy);
    isReplayingFailedUnitOfWork = false;
    originalReplayError = null;
    if (hasCaughtError()) {
      const replayError = clearCaughtError();
      if (replayError != null && thrownValue != null) {
        try {
          // Reading the expando property is intentionally
          // inside `try` because it might be a getter or Proxy.
          if (replayError._suppressLogging) {
            // Also suppress logging for the original error.
            (thrownValue: any)._suppressLogging = true;
          }
        } catch (inner) {
          // Ignore.
        }
      }
    } else {
      // If the begin phase did not fail the second time, set this pointer
      // back to the original value.
      nextUnitOfWork = failedUnitOfWork;
    }
  };
  rethrowOriginalError = () => {
    throw originalReplayError;
  };
}

function resetStack() {
  if (nextUnitOfWork !== null) {
    let interruptedWork = nextUnitOfWork.return;
    while (interruptedWork !== null) {
      unwindInterruptedWork(interruptedWork);
      interruptedWork = interruptedWork.return;
    }
  }

  if (__DEV__) {
    ReactStrictModeWarnings.discardPendingWarnings();
    checkThatStackIsEmpty();
  }

  nextRoot = null;
  nextRenderExpirationTime = NoWork;
  nextLatestAbsoluteTimeoutMs = -1;
  nextRenderDidError = false;
  nextUnitOfWork = null;
}

function commitAllHostEffects() {
  while (nextEffect !== null) {
    if (__DEV__) {
      ReactCurrentFiber.setCurrentFiber(nextEffect);
    }
    recordEffect();

    const effectTag = nextEffect.effectTag;

    if (effectTag & ContentReset) {
      commitResetTextContent(nextEffect);
    }

    if (effectTag & Ref) {
      const current = nextEffect.alternate;
      if (current !== null) {
        commitDetachRef(current);
      }
    }

    // The following switch statement is only concerned about placement,
    // updates, and deletions. To avoid needing to add a case for every
    // possible bitmap value, we remove the secondary effects from the
    // effect tag and switch on that value.
    let primaryEffectTag = effectTag & (Placement | Update | Deletion);
    switch (primaryEffectTag) {
      case Placement: {
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before
        // any life-cycles like componentDidMount gets called.
        // TODO: findDOMNode doesn't rely on this any more but isMounted
        // does and isMounted is deprecated anyway so we should be able
        // to kill this.
        nextEffect.effectTag &= ~Placement;
        break;
      }
      case PlacementAndUpdate: {
        // Placement
        commitPlacement(nextEffect);
        // Clear the "placement" from effect tag so that we know that this is inserted, before
        // any life-cycles like componentDidMount gets called.
        nextEffect.effectTag &= ~Placement;

        // Update
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Update: {
        const current = nextEffect.alternate;
        commitWork(current, nextEffect);
        break;
      }
      case Deletion: {
        commitDeletion(nextEffect);
        break;
      }
    }
    nextEffect = nextEffect.nextEffect;
  }

  if (__DEV__) {
    ReactCurrentFiber.resetCurrentFiber();
  }
}

function commitBeforeMutationLifecycles() {
  while (nextEffect !== null) {
    if (__DEV__) {
      ReactCurrentFiber.setCurrentFiber(nextEffect);
    }

    const effectTag = nextEffect.effectTag;
    if (effectTag & Snapshot) {
      recordEffect();
      const current = nextEffect.alternate;
      commitBeforeMutationLifeCycles(current, nextEffect);
    }

    // Don't cleanup effects yet;
    // This will be done by commitAllLifeCycles()
    nextEffect = nextEffect.nextEffect;
  }

  if (__DEV__) {
    ReactCurrentFiber.resetCurrentFiber();
  }
}

function commitLifeCycles(
  finishedRoot: FiberRoot,
  current: Fiber | null,
  finishedWork: Fiber,
  committedExpirationTime: ExpirationTime,
): void {
  switch (finishedWork.tag) {
    case ClassComponent:
    case ClassComponentLazy: {
      const instance = finishedWork.stateNode;
      if (finishedWork.effectTag & Update) {
        if (current === null) {
          startPhaseTimer(finishedWork, 'componentDidMount');
          instance.props = finishedWork.memoizedProps;
          instance.state = finishedWork.memoizedState;
          instance.componentDidMount();
          stopPhaseTimer();
        } else {
          const prevProps = current.memoizedProps;
          const prevState = current.memoizedState;
          startPhaseTimer(finishedWork, 'componentDidUpdate');
          instance.props = finishedWork.memoizedProps;
          instance.state = finishedWork.memoizedState;
          instance.componentDidUpdate(
            prevProps,
            prevState,
            instance.__reactInternalSnapshotBeforeUpdate,
          );
          stopPhaseTimer();
        }
      }
      const updateQueue = finishedWork.updateQueue;
      if (updateQueue !== null) {
        instance.props = finishedWork.memoizedProps;
        instance.state = finishedWork.memoizedState;
        commitUpdateQueue(
          finishedWork,
          updateQueue,
          instance,
          committedExpirationTime,
        );
      }
      return;
    }
    case HostRoot: {
      const updateQueue = finishedWork.updateQueue;
      if (updateQueue !== null) {
        let instance = null;
        if (finishedWork.child !== null) {
          switch (finishedWork.child.tag) {
            case HostComponent:
              instance = getPublicInstance(finishedWork.child.stateNode);
              break;
            case ClassComponent:
            case ClassComponentLazy:
              instance = finishedWork.child.stateNode;
              break;
          }
        }
        commitUpdateQueue(
          finishedWork,
          updateQueue,
          instance,
          committedExpirationTime,
        );
      }
      return;
    }
    case HostComponent: {
      const instance: Instance = finishedWork.stateNode;

      // Renderers may schedule work to be done after host components are mounted
      // (eg DOM renderer may schedule auto-focus for inputs and form controls).
      // These effects should only be committed when components are first mounted,
      // aka when there is no current/alternate.
      if (current === null && finishedWork.effectTag & Update) {
        const type = finishedWork.type;
        const props = finishedWork.memoizedProps;
        commitMount(instance, type, props, finishedWork);
      }

      return;
    }
    case HostText: {
      // We have no life-cycles associated with text.
      return;
    }
    case HostPortal: {
      // We have no life-cycles associated with portals.
      return;
    }
    case Profiler: {
      if (enableProfilerTimer) {
        const onRender = finishedWork.memoizedProps.onRender;

        if (enableSchedulerTracing) {
          onRender(
            finishedWork.memoizedProps.id,
            current === null ? 'mount' : 'update',
            finishedWork.actualDuration,
            finishedWork.treeBaseDuration,
            finishedWork.actualStartTime,
            getCommitTime(),
            finishedRoot.memoizedInteractions,
          );
        } else {
          onRender(
            finishedWork.memoizedProps.id,
            current === null ? 'mount' : 'update',
            finishedWork.actualDuration,
            finishedWork.treeBaseDuration,
            finishedWork.actualStartTime,
            getCommitTime(),
          );
        }
      }
      return;
    }
    case PlaceholderComponent: {
      if (enableSuspense) {
        if ((finishedWork.mode & StrictMode) === NoEffect) {
          // In loose mode, a placeholder times out by scheduling a synchronous
          // update in the commit phase. Use `updateQueue` field to signal that
          // the Timeout needs to switch to the placeholder. We don't need an
          // entire queue. Any non-null value works.
          // $FlowFixMe - Intentionally using a value other than an UpdateQueue.
          finishedWork.updateQueue = emptyObject;
          scheduleWork(finishedWork, Sync);
        } else {
          // In strict mode, the Update effect is used to record the time at
          // which the placeholder timed out.
          const currentTime = requestCurrentTime();
          finishedWork.stateNode = {timedOutAt: currentTime};
        }
      }
      return;
    }
    default: {
      invariant(
        false,
        'This unit of work tag should not have side-effects. This error is ' +
          'likely caused by a bug in React. Please file an issue.',
      );
    }
  }
}

function commitAllLifeCycles(
  finishedRoot: FiberRoot,
  committedExpirationTime: ExpirationTime,
) {
  if (__DEV__) {
    ReactStrictModeWarnings.flushPendingUnsafeLifecycleWarnings();

    if (warnAboutDeprecatedLifecycles) {
      ReactStrictModeWarnings.flushPendingDeprecationWarnings();
    }

    if (warnAboutLegacyContextAPI) {
      ReactStrictModeWarnings.flushLegacyContextWarning();
    }
  }
  while (nextEffect !== null) {
    const effectTag = nextEffect.effectTag;

    if (effectTag & (Update | Callback)) {
      recordEffect();
      const current = nextEffect.alternate;
      commitLifeCycles(
        finishedRoot,
        current,
        nextEffect,
        committedExpirationTime,
      );
    }

    if (effectTag & Ref) {
      recordEffect();
      commitAttachRef(nextEffect);
    }

    const next = nextEffect.nextEffect;
    // Ensure that we clean these up so that we don't accidentally keep them.
    // I'm not actually sure this matters because we can't reset firstEffect
    // and lastEffect since they're on every node, not just the effectful
    // ones. So we have to clean everything as we reuse nodes anyway.
    nextEffect.nextEffect = null;
    // Ensure that we reset the effectTag here so that we can rely on effect
    // tags to reason about the current life-cycle.
    nextEffect = next;
  }
}

function isAlreadyFailedLegacyErrorBoundary(instance: mixed): boolean {
  return (
    legacyErrorBoundariesThatAlreadyFailed !== null &&
    legacyErrorBoundariesThatAlreadyFailed.has(instance)
  );
}

function markLegacyErrorBoundaryAsFailed(instance: mixed) {
  if (legacyErrorBoundariesThatAlreadyFailed === null) {
    legacyErrorBoundariesThatAlreadyFailed = new Set([instance]);
  } else {
    legacyErrorBoundariesThatAlreadyFailed.add(instance);
  }
}

function commitRoot(root: FiberRoot, finishedWork: Fiber): void {
  isWorking = true;
  isCommitting = true;
  startCommitTimer();

  invariant(
    root.current !== finishedWork,
    'Cannot commit the same tree as before. This is probably a bug ' +
      'related to the return field. This error is likely caused by a bug ' +
      'in React. Please file an issue.',
  );
  const committedExpirationTime = root.pendingCommitExpirationTime;
  invariant(
    committedExpirationTime !== NoWork,
    'Cannot commit an incomplete root. This error is likely caused by a ' +
      'bug in React. Please file an issue.',
  );
  root.pendingCommitExpirationTime = NoWork;

  // Update the pending priority levels to account for the work that we are
  // about to commit. This needs to happen before calling the lifecycles, since
  // they may schedule additional updates.
  const updateExpirationTimeBeforeCommit = finishedWork.expirationTime;
  const childExpirationTimeBeforeCommit = finishedWork.childExpirationTime;
  const earliestRemainingTimeBeforeCommit =
    updateExpirationTimeBeforeCommit === NoWork ||
    (childExpirationTimeBeforeCommit !== NoWork &&
      childExpirationTimeBeforeCommit < updateExpirationTimeBeforeCommit)
      ? childExpirationTimeBeforeCommit
      : updateExpirationTimeBeforeCommit;
  markCommittedPriorityLevels(root, earliestRemainingTimeBeforeCommit);

  let prevInteractions: Set<Interaction> = (null: any);
  let committedInteractions: Array<Interaction> = enableSchedulerTracing
    ? []
    : (null: any);
  if (enableSchedulerTracing) {
    // Restore any pending interactions at this point,
    // So that cascading work triggered during the render phase will be accounted for.
    prevInteractions = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;

    // We are potentially finished with the current batch of interactions.
    // So we should clear them out of the pending interaction map.
    // We do this at the start of commit in case cascading work is scheduled by commit phase lifecycles.
    // In that event, interaction data may be added back into the pending map for a future commit.
    // We also store the interactions we are about to commit so that we can notify subscribers after we're done.
    // These are stored as an Array rather than a Set,
    // Because the same interaction may be pending for multiple expiration times,
    // In which case it's important that we decrement the count the right number of times after finishing.
    root.pendingInteractionMap.forEach(
      (scheduledInteractions, scheduledExpirationTime) => {
        if (scheduledExpirationTime <= committedExpirationTime) {
          committedInteractions.push(...Array.from(scheduledInteractions));
          root.pendingInteractionMap.delete(scheduledExpirationTime);
        }
      },
    );
  }

  // Reset this to null before calling lifecycles
  ReactCurrentOwner.current = null;

  let firstEffect;
  if (finishedWork.effectTag > PerformedWork) {
    // A fiber's effect list consists only of its children, not itself. So if
    // the root has an effect, we need to add it to the end of the list. The
    // resulting list is the set that would belong to the root's parent, if
    // it had one; that is, all the effects in the tree including the root.
    if (finishedWork.lastEffect !== null) {
      finishedWork.lastEffect.nextEffect = finishedWork;
      firstEffect = finishedWork.firstEffect;
    } else {
      firstEffect = finishedWork;
    }
  } else {
    // There is no effect on the root.
    firstEffect = finishedWork.firstEffect;
  }

  prepareForCommit(root.containerInfo);

  // Invoke instances of getSnapshotBeforeUpdate before mutation.
  nextEffect = firstEffect;
  startCommitSnapshotEffectsTimer();
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
      invokeGuardedCallback(null, commitBeforeMutationLifecycles, null);
      if (hasCaughtError()) {
        didError = true;
        error = clearCaughtError();
      }
    } else {
      try {
        commitBeforeMutationLifecycles();
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      // Clean-up
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }
  stopCommitSnapshotEffectsTimer();

  if (enableProfilerTimer) {
    // Mark the current commit time to be shared by all Profilers in this batch.
    // This enables them to be grouped later.
    recordCommitTime();
  }

  // Commit all the side-effects within a tree. We'll do this in two passes.
  // The first pass performs all the host insertions, updates, deletions and
  // ref unmounts.
  nextEffect = firstEffect;
  startCommitHostEffectsTimer();
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
      invokeGuardedCallback(null, commitAllHostEffects, null);
      if (hasCaughtError()) {
        didError = true;
        error = clearCaughtError();
      }
    } else {
      try {
        commitAllHostEffects();
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      // Clean-up
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }
  stopCommitHostEffectsTimer();

  resetAfterCommit(root.containerInfo);

  // The work-in-progress tree is now the current tree. This must come after
  // the first pass of the commit phase, so that the previous tree is still
  // current during componentWillUnmount, but before the second pass, so that
  // the finished work is current during componentDidMount/Update.
  root.current = finishedWork;

  // In the second pass we'll perform all life-cycles and ref callbacks.
  // Life-cycles happen as a separate pass so that all placements, updates,
  // and deletions in the entire tree have already been invoked.
  // This pass also triggers any renderer-specific initial effects.
  nextEffect = firstEffect;
  startCommitLifeCyclesTimer();
  while (nextEffect !== null) {
    let didError = false;
    let error;
    if (__DEV__) {
      invokeGuardedCallback(
        null,
        commitAllLifeCycles,
        null,
        root,
        committedExpirationTime,
      );
      if (hasCaughtError()) {
        didError = true;
        error = clearCaughtError();
      }
    } else {
      try {
        commitAllLifeCycles(root, committedExpirationTime);
      } catch (e) {
        didError = true;
        error = e;
      }
    }
    if (didError) {
      invariant(
        nextEffect !== null,
        'Should have next effect. This error is likely caused by a bug ' +
          'in React. Please file an issue.',
      );
      captureCommitPhaseError(nextEffect, error);
      if (nextEffect !== null) {
        nextEffect = nextEffect.nextEffect;
      }
    }
  }

  isCommitting = false;
  isWorking = false;
  stopCommitLifeCyclesTimer();
  stopCommitTimer();
  onCommitRoot(finishedWork.stateNode);
  if (__DEV__ && ReactFiberInstrumentation.debugTool) {
    ReactFiberInstrumentation.debugTool.onCommitWork(finishedWork);
  }

  const updateExpirationTimeAfterCommit = finishedWork.expirationTime;
  const childExpirationTimeAfterCommit = finishedWork.childExpirationTime;
  const earliestRemainingTimeAfterCommit =
    updateExpirationTimeAfterCommit === NoWork ||
    (childExpirationTimeAfterCommit !== NoWork &&
      childExpirationTimeAfterCommit < updateExpirationTimeAfterCommit)
      ? childExpirationTimeAfterCommit
      : updateExpirationTimeAfterCommit;
  if (earliestRemainingTimeAfterCommit === NoWork) {
    // If there's no remaining work, we can clear the set of already failed
    // error boundaries.
    legacyErrorBoundariesThatAlreadyFailed = null;
  }
  onCommit(root, earliestRemainingTimeAfterCommit);

  if (enableSchedulerTracing) {
    __interactionsRef.current = prevInteractions;

    let subscriber;

    try {
      subscriber = __subscriberRef.current;
      if (subscriber !== null && root.memoizedInteractions.size > 0) {
        const threadID = computeThreadID(
          committedExpirationTime,
          root.interactionThreadID,
        );
        subscriber.onWorkStopped(root.memoizedInteractions, threadID);
      }
    } catch (error) {
      // It's not safe for commitRoot() to throw.
      // Store the error for now and we'll re-throw in finishRendering().
      if (!hasUnhandledError) {
        hasUnhandledError = true;
        unhandledError = error;
      }
    } finally {
      // Don't update interaction counts if we're frozen due to suspense.
      // In this case, we can skip the completed-work check entirely.
      if (!suspenseDidTimeout) {
        // Now that we're done, check the completed batch of interactions.
        // If no more work is outstanding for a given interaction,
        // We need to notify the subscribers that it's finished.
        committedInteractions.forEach(interaction => {
          interaction.__count--;
          if (subscriber !== null && interaction.__count === 0) {
            try {
              subscriber.onInteractionScheduledWorkCompleted(interaction);
            } catch (error) {
              // It's not safe for commitRoot() to throw.
              // Store the error for now and we'll re-throw in finishRendering().
              if (!hasUnhandledError) {
                hasUnhandledError = true;
                unhandledError = error;
              }
            }
          }
        });
      }
    }
  }
}

function resetChildExpirationTime(
  workInProgress: Fiber,
  renderTime: ExpirationTime,
) {
  if (renderTime !== Never && workInProgress.childExpirationTime === Never) {
    // The children of this component are hidden. Don't bubble their
    // expiration times.
    return;
  }

  let newChildExpirationTime = NoWork;

  // Bubble up the earliest expiration time.
  if (enableProfilerTimer && workInProgress.mode & ProfileMode) {
    // We're in profiling mode.
    // Let's use this same traversal to update the render durations.
    let actualDuration = workInProgress.actualDuration;
    let treeBaseDuration = workInProgress.selfBaseDuration;

    // When a fiber is cloned, its actualDuration is reset to 0.
    // This value will only be updated if work is done on the fiber (i.e. it doesn't bailout).
    // When work is done, it should bubble to the parent's actualDuration.
    // If the fiber has not been cloned though, (meaning no work was done),
    // Then this value will reflect the amount of time spent working on a previous render.
    // In that case it should not bubble.
    // We determine whether it was cloned by comparing the child pointer.
    const shouldBubbleActualDurations =
      workInProgress.alternate === null ||
      workInProgress.child !== workInProgress.alternate.child;

    let child = workInProgress.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (
        newChildExpirationTime === NoWork ||
        (childUpdateExpirationTime !== NoWork &&
          childUpdateExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (
        newChildExpirationTime === NoWork ||
        (childChildExpirationTime !== NoWork &&
          childChildExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childChildExpirationTime;
      }
      if (shouldBubbleActualDurations) {
        actualDuration += child.actualDuration;
      }
      treeBaseDuration += child.treeBaseDuration;
      child = child.sibling;
    }
    workInProgress.actualDuration = actualDuration;
    workInProgress.treeBaseDuration = treeBaseDuration;
  } else {
    let child = workInProgress.child;
    while (child !== null) {
      const childUpdateExpirationTime = child.expirationTime;
      const childChildExpirationTime = child.childExpirationTime;
      if (
        newChildExpirationTime === NoWork ||
        (childUpdateExpirationTime !== NoWork &&
          childUpdateExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childUpdateExpirationTime;
      }
      if (
        newChildExpirationTime === NoWork ||
        (childChildExpirationTime !== NoWork &&
          childChildExpirationTime < newChildExpirationTime)
      ) {
        newChildExpirationTime = childChildExpirationTime;
      }
      child = child.sibling;
    }
  }

  workInProgress.childExpirationTime = newChildExpirationTime;
}

function completeUnitOfWork(workInProgress: Fiber): Fiber | null {
  // Attempt to complete the current unit of work, then move to the
  // next sibling. If there are no more siblings, return to the
  // parent fiber.
  while (true) {
    // The current, flushed, state of this fiber is the alternate.
    // Ideally nothing should rely on this, but relying on it here
    // means that we don't need an additional field on the work in
    // progress.
    const current = workInProgress.alternate;
    if (__DEV__) {
      ReactCurrentFiber.setCurrentFiber(workInProgress);
    }

    const returnFiber = workInProgress.return;
    const siblingFiber = workInProgress.sibling;

    if ((workInProgress.effectTag & Incomplete) === NoEffect) {
      // This fiber completed.
      if (enableProfilerTimer) {
        if (workInProgress.mode & ProfileMode) {
          startProfilerTimer(workInProgress);
        }

        nextUnitOfWork = completeWork(
          current,
          workInProgress,
          nextRenderExpirationTime,
        );

        if (workInProgress.mode & ProfileMode) {
          // Update render duration assuming we didn't error.
          stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);
        }
      } else {
        nextUnitOfWork = completeWork(
          current,
          workInProgress,
          nextRenderExpirationTime,
        );
      }
      let next = nextUnitOfWork;
      stopWorkTimer(workInProgress);
      resetChildExpirationTime(workInProgress, nextRenderExpirationTime);
      if (__DEV__) {
        ReactCurrentFiber.resetCurrentFiber();
      }

      if (next !== null) {
        stopWorkTimer(workInProgress);
        if (__DEV__ && ReactFiberInstrumentation.debugTool) {
          ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
        }
        // If completing this work spawned new work, do that next. We'll come
        // back here again.
        return next;
      }

      if (
        returnFiber !== null &&
        // Do not append effects to parents if a sibling failed to complete
        (returnFiber.effectTag & Incomplete) === NoEffect
      ) {
        // Append all the effects of the subtree and this fiber onto the effect
        // list of the parent. The completion order of the children affects the
        // side-effect order.
        if (returnFiber.firstEffect === null) {
          returnFiber.firstEffect = workInProgress.firstEffect;
        }
        if (workInProgress.lastEffect !== null) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress.firstEffect;
          }
          returnFiber.lastEffect = workInProgress.lastEffect;
        }

        // If this fiber had side-effects, we append it AFTER the children's
        // side-effects. We can perform certain side-effects earlier if
        // needed, by doing multiple passes over the effect list. We don't want
        // to schedule our own side-effect on our own list because if end up
        // reusing children we'll schedule this effect onto itself since we're
        // at the end.
        const effectTag = workInProgress.effectTag;
        // Skip both NoWork and PerformedWork tags when creating the effect list.
        // PerformedWork effect is read by React DevTools but shouldn't be committed.
        if (effectTag > PerformedWork) {
          if (returnFiber.lastEffect !== null) {
            returnFiber.lastEffect.nextEffect = workInProgress;
          } else {
            returnFiber.firstEffect = workInProgress;
          }
          returnFiber.lastEffect = workInProgress;
        }
      }

      if (__DEV__ && ReactFiberInstrumentation.debugTool) {
        ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
      }

      if (siblingFiber !== null) {
        // If there is more work to do in this returnFiber, do that next.
        return siblingFiber;
      } else if (returnFiber !== null) {
        // If there's no more work in this returnFiber. Complete the returnFiber.
        workInProgress = returnFiber;
        continue;
      } else {
        // We've reached the root.
        return null;
      }
    } else {
      if (workInProgress.mode & ProfileMode) {
        // Record the render duration for the fiber that errored.
        stopProfilerTimerIfRunningAndRecordDelta(workInProgress, false);
      }

      // This fiber did not complete because something threw. Pop values off
      // the stack without entering the complete phase. If this is a boundary,
      // capture values if possible.
      const next = unwindWork(workInProgress, nextRenderExpirationTime);
      // Because this fiber did not complete, don't reset its expiration time.
      if (workInProgress.effectTag & DidCapture) {
        // Restarting an error boundary
        stopFailedWorkTimer(workInProgress);
      } else {
        stopWorkTimer(workInProgress);
      }

      if (__DEV__) {
        ReactCurrentFiber.resetCurrentFiber();
      }

      if (next !== null) {
        stopWorkTimer(workInProgress);
        if (__DEV__ && ReactFiberInstrumentation.debugTool) {
          ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
        }

        if (enableProfilerTimer) {
          // Include the time spent working on failed children before continuing.
          if (next.mode & ProfileMode) {
            let actualDuration = next.actualDuration;
            let child = next.child;
            while (child !== null) {
              actualDuration += child.actualDuration;
              child = child.sibling;
            }
            next.actualDuration = actualDuration;
          }
        }

        // If completing this work spawned new work, do that next. We'll come
        // back here again.
        // Since we're restarting, remove anything that is not a host effect
        // from the effect tag.
        next.effectTag &= HostEffectMask;
        return next;
      }

      if (returnFiber !== null) {
        // Mark the parent fiber as incomplete and clear its effect list.
        returnFiber.firstEffect = returnFiber.lastEffect = null;
        returnFiber.effectTag |= Incomplete;
      }

      if (__DEV__ && ReactFiberInstrumentation.debugTool) {
        ReactFiberInstrumentation.debugTool.onCompleteWork(workInProgress);
      }

      if (siblingFiber !== null) {
        // If there is more work to do in this returnFiber, do that next.
        return siblingFiber;
      } else if (returnFiber !== null) {
        // If there's no more work in this returnFiber. Complete the returnFiber.
        workInProgress = returnFiber;
        continue;
      } else {
        return null;
      }
    }
  }

  // Without this explicit null return Flow complains of invalid return type
  // TODO Remove the above while(true) loop
  // eslint-disable-next-line no-unreachable
  return null;
}

function performUnitOfWork(workInProgress: Fiber): Fiber | null {
  // The current, flushed, state of this fiber is the alternate.
  // Ideally nothing should rely on this, but relying on it here
  // means that we don't need an additional field on the work in
  // progress.
  const current = workInProgress.alternate;

  // See if beginning this work spawns more work.
  startWorkTimer(workInProgress);
  if (__DEV__) {
    ReactCurrentFiber.setCurrentFiber(workInProgress);
  }

  if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
    stashedWorkInProgressProperties = assignFiberPropertiesInDEV(
      stashedWorkInProgressProperties,
      workInProgress,
    );
  }

  let next;
  if (enableProfilerTimer) {
    if (workInProgress.mode & ProfileMode) {
      startProfilerTimer(workInProgress);
    }

    next = beginWork(current, workInProgress, nextRenderExpirationTime);

    if (workInProgress.mode & ProfileMode) {
      // Record the render duration assuming we didn't bailout (or error).
      stopProfilerTimerIfRunningAndRecordDelta(workInProgress, true);
    }
  } else {
    next = beginWork(current, workInProgress, nextRenderExpirationTime);
  }

  if (__DEV__) {
    ReactCurrentFiber.resetCurrentFiber();
    if (isReplayingFailedUnitOfWork) {
      // Currently replaying a failed unit of work. This should be unreachable,
      // because the render phase is meant to be idempotent, and it should
      // have thrown again. Since it didn't, rethrow the original error, so
      // React's internal stack is not misaligned.
      rethrowOriginalError();
    }
  }
  if (__DEV__ && ReactFiberInstrumentation.debugTool) {
    ReactFiberInstrumentation.debugTool.onBeginWork(workInProgress);
  }

  if (next === null) {
    // If this doesn't spawn new work, complete the current work.
    next = completeUnitOfWork(workInProgress);
  }

  ReactCurrentOwner.current = null;

  return next;
}

function workLoop(isYieldy) {
  if (!isYieldy) {
    // Flush work without yielding
    while (nextUnitOfWork !== null) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    }
  } else {
    // Flush asynchronous work until the deadline runs out of time.
    while (nextUnitOfWork !== null && !shouldYield()) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
    }
  }
}

function throwException(
  root: FiberRoot,
  returnFiber: Fiber,
  sourceFiber: Fiber,
  value: mixed,
  renderExpirationTime: ExpirationTime,
) {
  // The source fiber did not complete.
  sourceFiber.effectTag |= Incomplete;
  // Its effect list is no longer valid.
  sourceFiber.firstEffect = sourceFiber.lastEffect = null;

  if (
    enableSuspense &&
    value !== null &&
    typeof value === 'object' &&
    typeof value.then === 'function'
  ) {
    // This is a thenable.
    const thenable: Thenable = (value: any);

    // Find the earliest timeout threshold of all the placeholders in the
    // ancestor path. We could avoid this traversal by storing the thresholds on
    // the stack, but we choose not to because we only hit this path if we're
    // IO-bound (i.e. if something suspends). Whereas the stack is used even in
    // the non-IO- bound case.
    let workInProgress = returnFiber;
    let earliestTimeoutMs = -1;
    let startTimeMs = -1;
    do {
      if (workInProgress.tag === PlaceholderComponent) {
        const current = workInProgress.alternate;
        if (
          current !== null &&
          current.memoizedState === true &&
          current.stateNode !== null
        ) {
          // Reached a placeholder that already timed out. Each timed out
          // placeholder acts as the root of a new suspense boundary.

          // Use the time at which the placeholder timed out as the start time
          // for the current render.
          const timedOutAt = current.stateNode.timedOutAt;
          startTimeMs = expirationTimeToMs(timedOutAt);

          // Do not search any further.
          break;
        }
        let timeoutPropMs = workInProgress.pendingProps.delayMs;
        if (typeof timeoutPropMs === 'number') {
          if (timeoutPropMs <= 0) {
            earliestTimeoutMs = 0;
          } else if (
            earliestTimeoutMs === -1 ||
            timeoutPropMs < earliestTimeoutMs
          ) {
            earliestTimeoutMs = timeoutPropMs;
          }
        }
      }
      workInProgress = workInProgress.return;
    } while (workInProgress !== null);

    // Schedule the nearest Placeholder to re-render the timed out view.
    workInProgress = returnFiber;
    do {
      if (workInProgress.tag === PlaceholderComponent) {
        const didTimeout = workInProgress.memoizedState;
        if (!didTimeout) {
          // Found the nearest boundary.

          // If the boundary is not in async mode, we should not suspend, and
          // likewise, when the promise resolves, we should ping synchronously.
          const pingTime =
            (workInProgress.mode & AsyncMode) === NoEffect
              ? Sync
              : renderExpirationTime;

          // Attach a listener to the promise to "ping" the root and retry.
          const onResolveOrReject = retrySuspendedRoot.bind(
            null,
            root,
            workInProgress,
            pingTime,
          );
          thenable.then(onResolveOrReject, onResolveOrReject);

          // If the boundary is outside of strict mode, we should *not* suspend
          // the commit. Pretend as if the suspended component rendered null and
          // keep rendering. In the commit phase, we'll schedule a subsequent
          // synchronous update to re-render the Placeholder.
          //
          // Note: It doesn't matter whether the component that suspended was
          // inside a strict mode tree. If the Placeholder is outside of it, we
          // should *not* suspend the commit.
          if ((workInProgress.mode & StrictMode) === NoEffect) {
            workInProgress.effectTag |= UpdateEffect;

            // Unmount the source fiber's children
            const nextChildren = null;
            reconcileChildren(
              sourceFiber.alternate,
              sourceFiber,
              nextChildren,
              renderExpirationTime,
            );
            sourceFiber.effectTag &= ~Incomplete;
            if (sourceFiber.tag === IndeterminateComponent) {
              // Let's just assume it's a functional component. This fiber will
              // be unmounted in the immediate next commit, anyway.
              sourceFiber.tag = FunctionalComponent;
            }

            if (
              sourceFiber.tag === ClassComponent ||
              sourceFiber.tag === ClassComponentLazy
            ) {
              // We're going to commit this fiber even though it didn't
              // complete. But we shouldn't call any lifecycle methods or
              // callbacks. Remove all lifecycle effect tags.
              sourceFiber.effectTag &= ~LifecycleEffectMask;
              if (sourceFiber.alternate === null) {
                // We're about to mount a class component that doesn't have an
                // instance. Turn this into a dummy functional component instead,
                // to prevent type errors. This is a bit weird but it's an edge
                // case and we're about to synchronously delete this
                // component, anyway.
                sourceFiber.tag = FunctionalComponent;
                sourceFiber.type = NoopComponent;
              }
            }

            // Exit without suspending.
            return;
          }

          // Confirmed that the boundary is in a strict mode tree. Continue with
          // the normal suspend path.

          let absoluteTimeoutMs;
          if (earliestTimeoutMs === -1) {
            // If no explicit threshold is given, default to an abitrarily large
            // value. The actual size doesn't matter because the threshold for the
            // whole tree will be clamped to the expiration time.
            absoluteTimeoutMs = maxSigned31BitInt;
          } else {
            if (startTimeMs === -1) {
              // This suspend happened outside of any already timed-out
              // placeholders. We don't know exactly when the update was scheduled,
              // but we can infer an approximate start time from the expiration
              // time. First, find the earliest uncommitted expiration time in the
              // tree, including work that is suspended. Then subtract the offset
              // used to compute an async update's expiration time. This will cause
              // high priority (interactive) work to expire earlier than necessary,
              // but we can account for this by adjusting for the Just Noticeable
              // Difference.
              const earliestExpirationTime = findEarliestOutstandingPriorityLevel(
                root,
                renderExpirationTime,
              );
              const earliestExpirationTimeMs = expirationTimeToMs(
                earliestExpirationTime,
              );
              startTimeMs = earliestExpirationTimeMs - LOW_PRIORITY_EXPIRATION;
            }
            absoluteTimeoutMs = startTimeMs + earliestTimeoutMs;
          }

          // Mark the earliest timeout in the suspended fiber's ancestor path.
          // After completing the root, we'll take the largest of all the
          // suspended fiber's timeouts and use it to compute a timeout for the
          // whole tree.
          renderDidSuspend(root, absoluteTimeoutMs, renderExpirationTime);

          workInProgress.effectTag |= ShouldCapture;
          workInProgress.expirationTime = renderExpirationTime;
          return;
        }
        // This boundary already captured during this render. Continue to the
        // next boundary.
      }
      workInProgress = workInProgress.return;
    } while (workInProgress !== null);
    // No boundary was found. Fallthrough to error mode.
    value = new Error(
      'An update was suspended, but no placeholder UI was provided.',
    );
  }

  // We didn't find a boundary that could handle this type of exception. Start
  // over and traverse parent path again, this time treating the exception
  // as an error.
  renderDidError();
  value = createCapturedValue(value, sourceFiber);
  let workInProgress = returnFiber;
  do {
    switch (workInProgress.tag) {
      case HostRoot: {
        const errorInfo = value;
        workInProgress.effectTag |= ShouldCapture;
        workInProgress.expirationTime = renderExpirationTime;
        const update = createRootErrorUpdate(
          workInProgress,
          errorInfo,
          renderExpirationTime,
        );
        enqueueCapturedUpdate(workInProgress, update);
        return;
      }
      case ClassComponent:
      case ClassComponentLazy:
        // Capture and retry
        const errorInfo = value;
        const ctor = workInProgress.type;
        const instance = workInProgress.stateNode;
        if (
          (workInProgress.effectTag & DidCapture) === NoEffect &&
          ((typeof ctor.getDerivedStateFromCatch === 'function' &&
            enableGetDerivedStateFromCatch) ||
            (instance !== null &&
              typeof instance.componentDidCatch === 'function' &&
              !isAlreadyFailedLegacyErrorBoundary(instance)))
        ) {
          workInProgress.effectTag |= ShouldCapture;
          workInProgress.expirationTime = renderExpirationTime;
          // Schedule the error boundary to re-render using updated state
          const update = createClassErrorUpdate(
            workInProgress,
            errorInfo,
            renderExpirationTime,
          );
          enqueueCapturedUpdate(workInProgress, update);
          return;
        }
        break;
      default:
        break;
    }
    workInProgress = workInProgress.return;
  } while (workInProgress !== null);
}

function renderRoot(
  root: FiberRoot,
  isYieldy: boolean,
  isExpired: boolean,
): void {
  invariant(
    !isWorking,
    'renderRoot was called recursively. This error is likely caused ' +
      'by a bug in React. Please file an issue.',
  );
  isWorking = true;
  ReactCurrentOwner.currentDispatcher = Dispatcher;

  const expirationTime = root.nextExpirationTimeToWorkOn;

  let prevInteractions: Set<Interaction> = (null: any);
  if (enableSchedulerTracing) {
    // We're about to start new traced work.
    // Restore pending interactions so cascading work triggered during the render phase will be accounted for.
    prevInteractions = __interactionsRef.current;
    __interactionsRef.current = root.memoizedInteractions;
  }

  // Check if we're starting from a fresh stack, or if we're resuming from
  // previously yielded work.
  if (
    expirationTime !== nextRenderExpirationTime ||
    root !== nextRoot ||
    nextUnitOfWork === null
  ) {
    // Reset the stack and start working from the root.
    resetStack();
    nextRoot = root;
    nextRenderExpirationTime = expirationTime;
    nextUnitOfWork = createWorkInProgress(
      nextRoot.current,
      null,
      nextRenderExpirationTime,
    );
    root.pendingCommitExpirationTime = NoWork;

    if (enableSchedulerTracing) {
      // Determine which interactions this batch of work currently includes,
      // So that we can accurately attribute time spent working on it,
      // And so that cascading work triggered during the render phase will be associated with it.
      const interactions: Set<Interaction> = new Set();
      root.pendingInteractionMap.forEach(
        (scheduledInteractions, scheduledExpirationTime) => {
          if (scheduledExpirationTime <= expirationTime) {
            scheduledInteractions.forEach(interaction =>
              interactions.add(interaction),
            );
          }
        },
      );

      // Store the current set of interactions on the FiberRoot for a few reasons:
      // We can re-use it in hot functions like renderRoot() without having to recalculate it.
      // We will also use it in commitWork() to pass to any Profiler onRender() hooks.
      // This also provides DevTools with a way to access it when the onCommitRoot() hook is called.
      root.memoizedInteractions = interactions;

      if (interactions.size > 0) {
        const subscriber = __subscriberRef.current;
        if (subscriber !== null) {
          const threadID = computeThreadID(
            expirationTime,
            root.interactionThreadID,
          );
          try {
            subscriber.onWorkStarted(interactions, threadID);
          } catch (error) {
            // Work thrown by an interaction tracing subscriber should be rethrown,
            // But only once it's safe (to avoid leaveing the scheduler in an invalid state).
            // Store the error for now and we'll re-throw in finishRendering().
            if (!hasUnhandledError) {
              hasUnhandledError = true;
              unhandledError = error;
            }
          }
        }
      }
    }
  }

  let didFatal = false;

  startWorkLoopTimer(nextUnitOfWork);

  do {
    try {
      workLoop(isYieldy);
    } catch (thrownValue) {
      if (nextUnitOfWork === null) {
        // This is a fatal error.
        didFatal = true;
        onUncaughtError(thrownValue);
      } else {
        if (__DEV__) {
          // Reset global debug state
          // We assume this is defined in DEV
          (resetCurrentlyProcessingQueue: any)();
        }

        const failedUnitOfWork: Fiber = nextUnitOfWork;
        if (__DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback) {
          replayUnitOfWork(failedUnitOfWork, thrownValue, isYieldy);
        }

        // TODO: we already know this isn't true in some cases.
        // At least this shows a nicer error message until we figure out the cause.
        // https://github.com/facebook/react/issues/12449#issuecomment-386727431
        invariant(
          nextUnitOfWork !== null,
          'Failed to replay rendering after an error. This ' +
            'is likely caused by a bug in React. Please file an issue ' +
            'with a reproducing case to help us find it.',
        );

        const sourceFiber: Fiber = nextUnitOfWork;
        let returnFiber = sourceFiber.return;
        if (returnFiber === null) {
          // This is the root. The root could capture its own errors. However,
          // we don't know if it errors before or after we pushed the host
          // context. This information is needed to avoid a stack mismatch.
          // Because we're not sure, treat this as a fatal error. We could track
          // which phase it fails in, but doesn't seem worth it. At least
          // for now.
          didFatal = true;
          onUncaughtError(thrownValue);
        } else {
          throwException(
            root,
            returnFiber,
            sourceFiber,
            thrownValue,
            nextRenderExpirationTime,
          );
          nextUnitOfWork = completeUnitOfWork(sourceFiber);
          continue;
        }
      }
    }
    break;
  } while (true);

  if (enableSchedulerTracing) {
    // Traced work is done for now; restore the previous interactions.
    __interactionsRef.current = prevInteractions;
  }

  // We're done performing work. Time to clean up.
  isWorking = false;
  ReactCurrentOwner.currentDispatcher = null;
  resetContextDependences();

  // Yield back to main thread.
  if (didFatal) {
    const didCompleteRoot = false;
    stopWorkLoopTimer(interruptedBy, didCompleteRoot);
    interruptedBy = null;
    // There was a fatal error.
    if (__DEV__) {
      resetStackAfterFatalErrorInDev();
    }
    // `nextRoot` points to the in-progress root. A non-null value indicates
    // that we're in the middle of an async render. Set it to null to indicate
    // there's no more work to be done in the current batch.
    nextRoot = null;
    onFatal(root);
    return;
  }

  if (nextUnitOfWork !== null) {
    // There's still remaining async work in this tree, but we ran out of time
    // in the current frame. Yield back to the renderer. Unless we're
    // interrupted by a higher priority update, we'll continue later from where
    // we left off.
    const didCompleteRoot = false;
    stopWorkLoopTimer(interruptedBy, didCompleteRoot);
    interruptedBy = null;
    onYield(root);
    return;
  }

  // We completed the whole tree.
  const didCompleteRoot = true;
  stopWorkLoopTimer(interruptedBy, didCompleteRoot);
  const rootWorkInProgress = root.current.alternate;
  invariant(
    rootWorkInProgress !== null,
    'Finished root should have a work-in-progress. This error is likely ' +
      'caused by a bug in React. Please file an issue.',
  );

  // `nextRoot` points to the in-progress root. A non-null value indicates
  // that we're in the middle of an async render. Set it to null to indicate
  // there's no more work to be done in the current batch.
  nextRoot = null;
  interruptedBy = null;

  if (nextRenderDidError) {
    // There was an error
    if (hasLowerPriorityWork(root, expirationTime)) {
      // There's lower priority work. If so, it may have the effect of fixing
      // the exception that was just thrown. Exit without committing. This is
      // similar to a suspend, but without a timeout because we're not waiting
      // for a promise to resolve. React will restart at the lower
      // priority level.
      markSuspendedPriorityLevel(root, expirationTime);
      const suspendedExpirationTime = expirationTime;
      const rootExpirationTime = root.expirationTime;
      onSuspend(
        root,
        rootWorkInProgress,
        suspendedExpirationTime,
        rootExpirationTime,
        -1, // Indicates no timeout
      );
      return;
    } else if (
      // There's no lower priority work, but we're rendering asynchronously.
      // Synchronsouly attempt to render the same level one more time. This is
      // similar to a suspend, but without a timeout because we're not waiting
      // for a promise to resolve.
      !root.didError &&
      !isExpired
    ) {
      root.didError = true;
      const suspendedExpirationTime = (root.nextExpirationTimeToWorkOn = expirationTime);
      const rootExpirationTime = (root.expirationTime = Sync);
      onSuspend(
        root,
        rootWorkInProgress,
        suspendedExpirationTime,
        rootExpirationTime,
        -1, // Indicates no timeout
      );
      return;
    }
  }

  if (enableSuspense && !isExpired && nextLatestAbsoluteTimeoutMs !== -1) {
    // The tree was suspended.
    const suspendedExpirationTime = expirationTime;
    markSuspendedPriorityLevel(root, suspendedExpirationTime);

    // Find the earliest uncommitted expiration time in the tree, including
    // work that is suspended. The timeout threshold cannot be longer than
    // the overall expiration.
    const earliestExpirationTime = findEarliestOutstandingPriorityLevel(
      root,
      expirationTime,
    );
    const earliestExpirationTimeMs = expirationTimeToMs(earliestExpirationTime);
    if (earliestExpirationTimeMs < nextLatestAbsoluteTimeoutMs) {
      nextLatestAbsoluteTimeoutMs = earliestExpirationTimeMs;
    }

    // Subtract the current time from the absolute timeout to get the number
    // of milliseconds until the timeout. In other words, convert an absolute
    // timestamp to a relative time. This is the value that is passed
    // to `setTimeout`.
    const currentTimeMs = expirationTimeToMs(requestCurrentTime());
    let msUntilTimeout = nextLatestAbsoluteTimeoutMs - currentTimeMs;
    msUntilTimeout = msUntilTimeout < 0 ? 0 : msUntilTimeout;

    // TODO: Account for the Just Noticeable Difference

    const rootExpirationTime = root.expirationTime;
    onSuspend(
      root,
      rootWorkInProgress,
      suspendedExpirationTime,
      rootExpirationTime,
      msUntilTimeout,
    );
    return;
  }

  // Ready to commit.
  onComplete(root, rootWorkInProgress, expirationTime);
}

function createRootErrorUpdate(
  fiber: Fiber,
  errorInfo: CapturedValue<mixed>,
  expirationTime: ExpirationTime,
): Update<mixed> {
  const update = createUpdate(expirationTime);
  // Unmount the root by rendering null.
  update.tag = CaptureUpdate;
  // Caution: React DevTools currently depends on this property
  // being called "element".
  update.payload = {element: null};
  const error = errorInfo.value;
  update.callback = () => {
    onUncaughtError(error);
    logError(fiber, errorInfo);
  };
  return update;
}

function createClassErrorUpdate(
  fiber: Fiber,
  errorInfo: CapturedValue<mixed>,
  expirationTime: ExpirationTime,
): Update<mixed> {
  const update = createUpdate(expirationTime);
  update.tag = CaptureUpdate;
  const getDerivedStateFromCatch = fiber.type.getDerivedStateFromCatch;
  if (
    enableGetDerivedStateFromCatch &&
    typeof getDerivedStateFromCatch === 'function'
  ) {
    const error = errorInfo.value;
    update.payload = () => {
      return getDerivedStateFromCatch(error);
    };
  }

  const inst = fiber.stateNode;
  if (inst !== null && typeof inst.componentDidCatch === 'function') {
    update.callback = function callback() {
      if (
        !enableGetDerivedStateFromCatch ||
        getDerivedStateFromCatch !== 'function'
      ) {
        // To preserve the preexisting retry behavior of error boundaries,
        // we keep track of which ones already failed during this batch.
        // This gets reset before we yield back to the browser.
        // TODO: Warn in strict mode if getDerivedStateFromCatch is
        // not defined.
        markLegacyErrorBoundaryAsFailed(this);
      }
      const error = errorInfo.value;
      const stack = errorInfo.stack;
      logError(fiber, errorInfo);
      this.componentDidCatch(error, {
        componentStack: stack !== null ? stack : '',
      });
    };
  }
  return update;
}

function dispatch(
  sourceFiber: Fiber,
  value: mixed,
  expirationTime: ExpirationTime,
) {
  invariant(
    !isWorking || isCommitting,
    'dispatch: Cannot dispatch during the render phase.',
  );

  let fiber = sourceFiber.return;
  while (fiber !== null) {
    switch (fiber.tag) {
      case ClassComponent:
      case ClassComponentLazy:
        const ctor = fiber.type;
        const instance = fiber.stateNode;
        if (
          typeof ctor.getDerivedStateFromCatch === 'function' ||
          (typeof instance.componentDidCatch === 'function' &&
            !isAlreadyFailedLegacyErrorBoundary(instance))
        ) {
          const errorInfo = createCapturedValue(value, sourceFiber);
          const update = createClassErrorUpdate(
            fiber,
            errorInfo,
            expirationTime,
          );
          enqueueUpdate(fiber, update);
          scheduleWork(fiber, expirationTime);
          return;
        }
        break;
      case HostRoot: {
        const errorInfo = createCapturedValue(value, sourceFiber);
        const update = createRootErrorUpdate(fiber, errorInfo, expirationTime);
        enqueueUpdate(fiber, update);
        scheduleWork(fiber, expirationTime);
        return;
      }
    }
    fiber = fiber.return;
  }

  if (sourceFiber.tag === HostRoot) {
    // Error was thrown at the root. There is no parent, so the root
    // itself should capture it.
    const rootFiber = sourceFiber;
    const errorInfo = createCapturedValue(value, rootFiber);
    const update = createRootErrorUpdate(rootFiber, errorInfo, expirationTime);
    enqueueUpdate(rootFiber, update);
    scheduleWork(rootFiber, expirationTime);
  }
}

function captureCommitPhaseError(fiber: Fiber, error: mixed) {
  return dispatch(fiber, error, Sync);
}

function computeThreadID(
  expirationTime: ExpirationTime,
  interactionThreadID: number,
): number {
  // Interaction threads are unique per root and expiration time.
  return expirationTime * 1000 + interactionThreadID;
}

// Creates a unique async expiration time.
function computeUniqueAsyncExpiration(): ExpirationTime {
  const currentTime = requestCurrentTime();
  let result = computeAsyncExpiration(currentTime);
  if (result <= lastUniqueAsyncExpiration) {
    // Since we assume the current time monotonically increases, we only hit
    // this branch when computeUniqueAsyncExpiration is fired multiple times
    // within a 200ms window (or whatever the async bucket size is).
    result = lastUniqueAsyncExpiration + 1;
  }
  lastUniqueAsyncExpiration = result;
  return lastUniqueAsyncExpiration;
}

function computeExpirationForFiber(currentTime: ExpirationTime, fiber: Fiber) {
  let expirationTime;
  if (expirationContext !== NoWork) {
    // An explicit expiration context was set;
    expirationTime = expirationContext;
  } else if (isWorking) {
    if (isCommitting) {
      // Updates that occur during the commit phase should have sync priority
      // by default.
      expirationTime = Sync;
    } else {
      // Updates during the render phase should expire at the same time as
      // the work that is being rendered.
      expirationTime = nextRenderExpirationTime;
    }
  } else {
    // No explicit expiration context was set, and we're not currently
    // performing work. Calculate a new expiration time.
    if (fiber.mode & AsyncMode) {
      if (isBatchingInteractiveUpdates) {
        // This is an interactive update
        expirationTime = computeInteractiveExpiration(currentTime);
      } else {
        // This is an async update
        expirationTime = computeAsyncExpiration(currentTime);
      }
      // If we're in the middle of rendering a tree, do not update at the same
      // expiration time that is already rendering.
      if (nextRoot !== null && expirationTime === nextRenderExpirationTime) {
        expirationTime += 1;
      }
    } else {
      // This is a sync update
      expirationTime = Sync;
    }
  }
  if (isBatchingInteractiveUpdates) {
    // This is an interactive update. Keep track of the lowest pending
    // interactive expiration time. This allows us to synchronously flush
    // all interactive updates when needed.
    if (
      lowestPriorityPendingInteractiveExpirationTime === NoWork ||
      expirationTime > lowestPriorityPendingInteractiveExpirationTime
    ) {
      lowestPriorityPendingInteractiveExpirationTime = expirationTime;
    }
  }
  return expirationTime;
}

function renderDidSuspend(
  root: FiberRoot,
  absoluteTimeoutMs: number,
  suspendedTime: ExpirationTime,
) {
  // Schedule the timeout.
  if (
    absoluteTimeoutMs >= 0 &&
    nextLatestAbsoluteTimeoutMs < absoluteTimeoutMs
  ) {
    nextLatestAbsoluteTimeoutMs = absoluteTimeoutMs;
  }
}

function renderDidError() {
  nextRenderDidError = true;
}

function retrySuspendedRoot(
  root: FiberRoot,
  fiber: Fiber,
  suspendedTime: ExpirationTime,
) {
  if (enableSuspense) {
    let retryTime;

    if (isPriorityLevelSuspended(root, suspendedTime)) {
      // Ping at the original level
      retryTime = suspendedTime;
      markPingedPriorityLevel(root, retryTime);
    } else {
      // Placeholder already timed out. Compute a new expiration time
      const currentTime = requestCurrentTime();
      retryTime = computeExpirationForFiber(currentTime, fiber);
      markPendingPriorityLevel(root, retryTime);
    }

    scheduleWorkToRoot(fiber, retryTime);
    const rootExpirationTime = root.expirationTime;
    if (rootExpirationTime !== NoWork) {
      if (enableSchedulerTracing) {
        // Restore previous interactions so that new work is associated with them.
        let prevInteractions = __interactionsRef.current;
        __interactionsRef.current = root.memoizedInteractions;
        // Because suspense timeouts do not decrement the interaction count,
        // Continued suspense work should also not increment the count.
        storeInteractionsForExpirationTime(root, rootExpirationTime, false);
        requestWork(root, rootExpirationTime);
        __interactionsRef.current = prevInteractions;
      } else {
        requestWork(root, rootExpirationTime);
      }
    }
  }
}

function scheduleWorkToRoot(fiber: Fiber, expirationTime): FiberRoot | null {
  // Update the source fiber's expiration time
  if (
    fiber.expirationTime === NoWork ||
    fiber.expirationTime > expirationTime
  ) {
    fiber.expirationTime = expirationTime;
  }
  let alternate = fiber.alternate;
  if (
    alternate !== null &&
    (alternate.expirationTime === NoWork ||
      alternate.expirationTime > expirationTime)
  ) {
    alternate.expirationTime = expirationTime;
  }
  // Walk the parent path to the root and update the child expiration time.
  let node = fiber.return;
  if (node === null && fiber.tag === HostRoot) {
    return fiber.stateNode;
  }
  while (node !== null) {
    alternate = node.alternate;
    if (
      node.childExpirationTime === NoWork ||
      node.childExpirationTime > expirationTime
    ) {
      node.childExpirationTime = expirationTime;
      if (
        alternate !== null &&
        (alternate.childExpirationTime === NoWork ||
          alternate.childExpirationTime > expirationTime)
      ) {
        alternate.childExpirationTime = expirationTime;
      }
    } else if (
      alternate !== null &&
      (alternate.childExpirationTime === NoWork ||
        alternate.childExpirationTime > expirationTime)
    ) {
      alternate.childExpirationTime = expirationTime;
    }
    if (node.return === null && node.tag === HostRoot) {
      return node.stateNode;
    }
    node = node.return;
  }
  return null;
}

function storeInteractionsForExpirationTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
  updateInteractionCounts: boolean,
): void {
  if (!enableSchedulerTracing) {
    return;
  }

  const interactions = __interactionsRef.current;
  if (interactions.size > 0) {
    const pendingInteractions = root.pendingInteractionMap.get(expirationTime);
    if (pendingInteractions != null) {
      interactions.forEach(interaction => {
        if (updateInteractionCounts && !pendingInteractions.has(interaction)) {
          // Update the pending async work count for previously unscheduled interaction.
          interaction.__count++;
        }

        pendingInteractions.add(interaction);
      });
    } else {
      root.pendingInteractionMap.set(expirationTime, new Set(interactions));

      // Update the pending async work count for the current interactions.
      if (updateInteractionCounts) {
        interactions.forEach(interaction => {
          interaction.__count++;
        });
      }
    }

    const subscriber = __subscriberRef.current;
    if (subscriber !== null) {
      const threadID = computeThreadID(
        expirationTime,
        root.interactionThreadID,
      );
      subscriber.onWorkScheduled(interactions, threadID);
    }
  }
}

function scheduleWork(fiber: Fiber, expirationTime: ExpirationTime) {
  recordScheduleUpdate();

  if (__DEV__) {
    if (fiber.tag === ClassComponent || fiber.tag === ClassComponentLazy) {
      const instance = fiber.stateNode;
      warnAboutInvalidUpdates(instance);
    }
  }

  const root = scheduleWorkToRoot(fiber, expirationTime);
  if (root === null) {
    if (
      __DEV__ &&
      (fiber.tag === ClassComponent || fiber.tag === ClassComponentLazy)
    ) {
      warnAboutUpdateOnUnmounted(fiber);
    }
    return;
  }

  if (enableSchedulerTracing) {
    storeInteractionsForExpirationTime(root, expirationTime, true);
  }

  if (
    !isWorking &&
    nextRenderExpirationTime !== NoWork &&
    expirationTime < nextRenderExpirationTime
  ) {
    // This is an interruption. (Used for performance tracking.)
    interruptedBy = fiber;
    resetStack();
  }
  markPendingPriorityLevel(root, expirationTime);
  if (
    // If we're in the render phase, we don't need to schedule this root
    // for an update, because we'll do it before we exit...
    !isWorking ||
    isCommitting ||
    // ...unless this is a different root than the one we're rendering.
    nextRoot !== root
  ) {
    const rootExpirationTime = root.expirationTime;
    requestWork(root, rootExpirationTime);
  }
  if (nestedUpdateCount > NESTED_UPDATE_LIMIT) {
    // Reset this back to zero so subsequent updates don't throw.
    nestedUpdateCount = 0;
    invariant(
      false,
      'Maximum update depth exceeded. This can happen when a ' +
        'component repeatedly calls setState inside ' +
        'componentWillUpdate or componentDidUpdate. React limits ' +
        'the number of nested updates to prevent infinite loops.',
    );
  }
}

function deferredUpdates<A>(fn: () => A): A {
  const currentTime = requestCurrentTime();
  const previousExpirationContext = expirationContext;
  const previousIsBatchingInteractiveUpdates = isBatchingInteractiveUpdates;
  expirationContext = computeAsyncExpiration(currentTime);
  isBatchingInteractiveUpdates = false;
  try {
    return fn();
  } finally {
    expirationContext = previousExpirationContext;
    isBatchingInteractiveUpdates = previousIsBatchingInteractiveUpdates;
  }
}

function syncUpdates<A, B, C0, D, R>(
  fn: (A, B, C0, D) => R,
  a: A,
  b: B,
  c: C0,
  d: D,
): R {
  const previousExpirationContext = expirationContext;
  expirationContext = Sync;
  try {
    return fn(a, b, c, d);
  } finally {
    expirationContext = previousExpirationContext;
  }
}

// TODO: Everything below this is written as if it has been lifted to the
// renderers. I'll do this in a follow-up.

// Linked-list of roots
let firstScheduledRoot: FiberRoot | null = null;
let lastScheduledRoot: FiberRoot | null = null;

let callbackExpirationTime: ExpirationTime = NoWork;
let callbackID: *;
let isRendering: boolean = false;
let nextFlushedRoot: FiberRoot | null = null;
let nextFlushedExpirationTime: ExpirationTime = NoWork;
let lowestPriorityPendingInteractiveExpirationTime: ExpirationTime = NoWork;
let deadlineDidExpire: boolean = false;
let hasUnhandledError: boolean = false;
let unhandledError: mixed | null = null;
let deadline: Deadline | null = null;

let isBatchingUpdates: boolean = false;
let isUnbatchingUpdates: boolean = false;
let isBatchingInteractiveUpdates: boolean = false;

let completedBatches: Array<Batch> | null = null;

let originalStartTimeMs: number = now();
let currentRendererTime: ExpirationTime = msToExpirationTime(
  originalStartTimeMs,
);
let currentSchedulerTime: ExpirationTime = currentRendererTime;

// Use these to prevent an infinite loop of nested updates
const NESTED_UPDATE_LIMIT = 50;
let nestedUpdateCount: number = 0;
let lastCommittedRootDuringThisBatch: FiberRoot | null = null;

const timeHeuristicForUnitOfWork = 1;

function recomputeCurrentRendererTime() {
  const currentTimeMs = now() - originalStartTimeMs;
  currentRendererTime = msToExpirationTime(currentTimeMs);
}

function scheduleCallbackWithExpirationTime(
  root: FiberRoot,
  expirationTime: ExpirationTime,
) {
  if (callbackExpirationTime !== NoWork) {
    // A callback is already scheduled. Check its expiration time (timeout).
    if (expirationTime > callbackExpirationTime) {
      // Existing callback has sufficient timeout. Exit.
      return;
    } else {
      if (callbackID !== null) {
        // Existing callback has insufficient timeout. Cancel and schedule a
        // new one.
        cancelDeferredCallback(callbackID);
      }
    }
    // The request callback timer is already running. Don't start a new one.
  } else {
    startRequestCallbackTimer();
  }

  callbackExpirationTime = expirationTime;
  const currentMs = now() - originalStartTimeMs;
  const expirationTimeMs = expirationTimeToMs(expirationTime);
  const timeout = expirationTimeMs - currentMs;
  callbackID = scheduleDeferredCallback(performAsyncWork, {timeout});
}

// For every call to renderRoot, one of onFatal, onComplete, onSuspend, and
// onYield is called upon exiting. We use these in lieu of returning a tuple.
// I've also chosen not to inline them into renderRoot because these will
// eventually be lifted into the renderer.
function onFatal(root) {
  root.finishedWork = null;
}

function onComplete(
  root: FiberRoot,
  finishedWork: Fiber,
  expirationTime: ExpirationTime,
) {
  root.pendingCommitExpirationTime = expirationTime;
  root.finishedWork = finishedWork;
}

function onSuspend(
  root: FiberRoot,
  finishedWork: Fiber,
  suspendedExpirationTime: ExpirationTime,
  rootExpirationTime: ExpirationTime,
  msUntilTimeout: number,
): void {
  root.expirationTime = rootExpirationTime;
  if (enableSuspense && msUntilTimeout === 0 && !shouldYield()) {
    // Don't wait an additional tick. Commit the tree immediately.
    root.pendingCommitExpirationTime = suspendedExpirationTime;
    root.finishedWork = finishedWork;
  } else if (msUntilTimeout > 0) {
    // Wait `msUntilTimeout` milliseconds before committing.
    root.timeoutHandle = scheduleTimeout(
      onTimeout.bind(null, root, finishedWork, suspendedExpirationTime),
      msUntilTimeout,
    );
  }
}

function onYield(root) {
  root.finishedWork = null;
}

function onTimeout(root, finishedWork, suspendedExpirationTime) {
  if (enableSuspense) {
    // The root timed out. Commit it.
    root.pendingCommitExpirationTime = suspendedExpirationTime;
    root.finishedWork = finishedWork;
    // Read the current time before entering the commit phase. We can be
    // certain this won't cause tearing related to batching of event updates
    // because we're at the top of a timer event.
    recomputeCurrentRendererTime();
    currentSchedulerTime = currentRendererTime;

    if (enableSchedulerTracing) {
      // Don't update pending interaction counts for suspense timeouts,
      // Because we know we still need to do more work in this case.
      suspenseDidTimeout = true;
      flushRoot(root, suspendedExpirationTime);
      suspenseDidTimeout = false;
    } else {
      flushRoot(root, suspendedExpirationTime);
    }
  }
}

function onCommit(root, expirationTime) {
  root.expirationTime = expirationTime;
  root.finishedWork = null;
}

function requestCurrentTime() {
  // requestCurrentTime is called by the scheduler to compute an expiration
  // time.
  //
  // Expiration times are computed by adding to the current time (the start
  // time). However, if two updates are scheduled within the same event, we
  // should treat their start times as simultaneous, even if the actual clock
  // time has advanced between the first and second call.

  // In other words, because expiration times determine how updates are batched,
  // we want all updates of like priority that occur within the same event to
  // receive the same expiration time. Otherwise we get tearing.
  //
  // We keep track of two separate times: the current "renderer" time and the
  // current "scheduler" time. The renderer time can be updated whenever; it
  // only exists to minimize the calls performance.now.
  //
  // But the scheduler time can only be updated if there's no pending work, or
  // if we know for certain that we're not in the middle of an event.

  if (isRendering) {
    // We're already rendering. Return the most recently read time.
    return currentSchedulerTime;
  }
  // Check if there's pending work.
  findHighestPriorityRoot();
  if (
    nextFlushedExpirationTime === NoWork ||
    nextFlushedExpirationTime === Never
  ) {
    // If there's no pending work, or if the pending work is offscreen, we can
    // read the current time without risk of tearing.
    recomputeCurrentRendererTime();
    currentSchedulerTime = currentRendererTime;
    return currentSchedulerTime;
  }
  // There's already pending work. We might be in the middle of a browser
  // event. If we were to read the current time, it could cause multiple updates
  // within the same event to receive different expiration times, leading to
  // tearing. Return the last read time. During the next idle callback, the
  // time will be updated.
  return currentSchedulerTime;
}

// requestWork is called by the scheduler whenever a root receives an update.
// It's up to the renderer to call renderRoot at some point in the future.
function requestWork(root: FiberRoot, expirationTime: ExpirationTime) {
  addRootToSchedule(root, expirationTime);
  if (isRendering) {
    // Prevent reentrancy. Remaining work will be scheduled at the end of
    // the currently rendering batch.
    return;
  }

  if (isBatchingUpdates) {
    // Flush work at the end of the batch.
    if (isUnbatchingUpdates) {
      // ...unless we're inside unbatchedUpdates, in which case we should
      // flush it now.
      nextFlushedRoot = root;
      nextFlushedExpirationTime = Sync;
      performWorkOnRoot(root, Sync, true);
    }
    return;
  }

  // TODO: Get rid of Sync and use current time?
  if (expirationTime === Sync) {
    performSyncWork();
  } else {
    scheduleCallbackWithExpirationTime(root, expirationTime);
  }
}

function addRootToSchedule(root: FiberRoot, expirationTime: ExpirationTime) {
  // Add the root to the schedule.
  // Check if this root is already part of the schedule.
  if (root.nextScheduledRoot === null) {
    // This root is not already scheduled. Add it.
    root.expirationTime = expirationTime;
    if (lastScheduledRoot === null) {
      firstScheduledRoot = lastScheduledRoot = root;
      root.nextScheduledRoot = root;
    } else {
      lastScheduledRoot.nextScheduledRoot = root;
      lastScheduledRoot = root;
      lastScheduledRoot.nextScheduledRoot = firstScheduledRoot;
    }
  } else {
    // This root is already scheduled, but its priority may have increased.
    const remainingExpirationTime = root.expirationTime;
    if (
      remainingExpirationTime === NoWork ||
      expirationTime < remainingExpirationTime
    ) {
      // Update the priority.
      root.expirationTime = expirationTime;
    }
  }
}

function findHighestPriorityRoot() {
  let highestPriorityWork = NoWork;
  let highestPriorityRoot = null;
  if (lastScheduledRoot !== null) {
    let previousScheduledRoot = lastScheduledRoot;
    let root = firstScheduledRoot;
    while (root !== null) {
      const remainingExpirationTime = root.expirationTime;
      if (remainingExpirationTime === NoWork) {
        // This root no longer has work. Remove it from the scheduler.

        // TODO: This check is redudant, but Flow is confused by the branch
        // below where we set lastScheduledRoot to null, even though we break
        // from the loop right after.
        invariant(
          previousScheduledRoot !== null && lastScheduledRoot !== null,
          'Should have a previous and last root. This error is likely ' +
            'caused by a bug in React. Please file an issue.',
        );
        if (root === root.nextScheduledRoot) {
          // This is the only root in the list.
          root.nextScheduledRoot = null;
          firstScheduledRoot = lastScheduledRoot = null;
          break;
        } else if (root === firstScheduledRoot) {
          // This is the first root in the list.
          const next = root.nextScheduledRoot;
          firstScheduledRoot = next;
          lastScheduledRoot.nextScheduledRoot = next;
          root.nextScheduledRoot = null;
        } else if (root === lastScheduledRoot) {
          // This is the last root in the list.
          lastScheduledRoot = previousScheduledRoot;
          lastScheduledRoot.nextScheduledRoot = firstScheduledRoot;
          root.nextScheduledRoot = null;
          break;
        } else {
          previousScheduledRoot.nextScheduledRoot = root.nextScheduledRoot;
          root.nextScheduledRoot = null;
        }
        root = previousScheduledRoot.nextScheduledRoot;
      } else {
        if (
          highestPriorityWork === NoWork ||
          remainingExpirationTime < highestPriorityWork
        ) {
          // Update the priority, if it's higher
          highestPriorityWork = remainingExpirationTime;
          highestPriorityRoot = root;
        }
        if (root === lastScheduledRoot) {
          break;
        }
        if (highestPriorityWork === Sync) {
          // Sync is highest priority by definition so
          // we can stop searching.
          break;
        }
        previousScheduledRoot = root;
        root = root.nextScheduledRoot;
      }
    }
  }

  nextFlushedRoot = highestPriorityRoot;
  nextFlushedExpirationTime = highestPriorityWork;
}

function performAsyncWork(dl) {
  if (dl.didTimeout) {
    // The callback timed out. That means at least one update has expired.
    // Iterate through the root schedule. If they contain expired work, set
    // the next render expiration time to the current time. This has the effect
    // of flushing all expired work in a single batch, instead of flushing each
    // level one at a time.
    if (firstScheduledRoot !== null) {
      recomputeCurrentRendererTime();
      let root: FiberRoot = firstScheduledRoot;
      do {
        didExpireAtExpirationTime(root, currentRendererTime);
        // The root schedule is circular, so this is never null.
        root = (root.nextScheduledRoot: any);
      } while (root !== firstScheduledRoot);
    }
  }
  performWork(NoWork, dl);
}

function performSyncWork() {
  performWork(Sync, null);
}

function performWork(minExpirationTime: ExpirationTime, dl: Deadline | null) {
  deadline = dl;

  // Keep working on roots until there's no more work, or until we reach
  // the deadline.
  findHighestPriorityRoot();

  if (deadline !== null) {
    recomputeCurrentRendererTime();
    currentSchedulerTime = currentRendererTime;

    if (enableUserTimingAPI) {
      const didExpire = nextFlushedExpirationTime < currentRendererTime;
      const timeout = expirationTimeToMs(nextFlushedExpirationTime);
      stopRequestCallbackTimer(didExpire, timeout);
    }

    while (
      nextFlushedRoot !== null &&
      nextFlushedExpirationTime !== NoWork &&
      (minExpirationTime === NoWork ||
        minExpirationTime >= nextFlushedExpirationTime) &&
      (!deadlineDidExpire || currentRendererTime >= nextFlushedExpirationTime)
    ) {
      performWorkOnRoot(
        nextFlushedRoot,
        nextFlushedExpirationTime,
        currentRendererTime >= nextFlushedExpirationTime,
      );
      findHighestPriorityRoot();
      recomputeCurrentRendererTime();
      currentSchedulerTime = currentRendererTime;
    }
  } else {
    while (
      nextFlushedRoot !== null &&
      nextFlushedExpirationTime !== NoWork &&
      (minExpirationTime === NoWork ||
        minExpirationTime >= nextFlushedExpirationTime)
    ) {
      performWorkOnRoot(nextFlushedRoot, nextFlushedExpirationTime, true);
      findHighestPriorityRoot();
    }
  }

  // We're done flushing work. Either we ran out of time in this callback,
  // or there's no more work left with sufficient priority.

  // If we're inside a callback, set this to false since we just completed it.
  if (deadline !== null) {
    callbackExpirationTime = NoWork;
    callbackID = null;
  }
  // If there's work left over, schedule a new callback.
  if (nextFlushedExpirationTime !== NoWork) {
    scheduleCallbackWithExpirationTime(
      ((nextFlushedRoot: any): FiberRoot),
      nextFlushedExpirationTime,
    );
  }

  // Clean-up.
  deadline = null;
  deadlineDidExpire = false;

  finishRendering();
}

function flushRoot(root: FiberRoot, expirationTime: ExpirationTime) {
  invariant(
    !isRendering,
    'work.commit(): Cannot commit while already rendering. This likely ' +
      'means you attempted to commit from inside a lifecycle method.',
  );
  // Perform work on root as if the given expiration time is the current time.
  // This has the effect of synchronously flushing all work up to and
  // including the given time.
  nextFlushedRoot = root;
  nextFlushedExpirationTime = expirationTime;
  performWorkOnRoot(root, expirationTime, true);
  // Flush any sync work that was scheduled by lifecycles
  performSyncWork();
}

function finishRendering() {
  nestedUpdateCount = 0;
  lastCommittedRootDuringThisBatch = null;

  if (completedBatches !== null) {
    const batches = completedBatches;
    completedBatches = null;
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        batch._onComplete();
      } catch (error) {
        if (!hasUnhandledError) {
          hasUnhandledError = true;
          unhandledError = error;
        }
      }
    }
  }

  if (hasUnhandledError) {
    const error = unhandledError;
    unhandledError = null;
    hasUnhandledError = false;
    throw error;
  }
}

function performWorkOnRoot(
  root: FiberRoot,
  expirationTime: ExpirationTime,
  isExpired: boolean,
) {
  invariant(
    !isRendering,
    'performWorkOnRoot was called recursively. This error is likely caused ' +
      'by a bug in React. Please file an issue.',
  );

  isRendering = true;

  // Check if this is async work or sync/expired work.
  if (deadline === null || isExpired) {
    // Flush work without yielding.
    // TODO: Non-yieldy work does not necessarily imply expired work. A renderer
    // may want to perform some work without yielding, but also without
    // requiring the root to complete (by triggering placeholders).

    let finishedWork = root.finishedWork;
    if (finishedWork !== null) {
      // This root is already complete. We can commit it.
      completeRoot(root, finishedWork, expirationTime);
    } else {
      root.finishedWork = null;
      // If this root previously suspended, clear its existing timeout, since
      // we're about to try rendering again.
      const timeoutHandle = root.timeoutHandle;
      if (enableSuspense && timeoutHandle !== noTimeout) {
        root.timeoutHandle = noTimeout;
        // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
        cancelTimeout(timeoutHandle);
      }
      const isYieldy = false;
      renderRoot(root, isYieldy, isExpired);
      finishedWork = root.finishedWork;
      if (finishedWork !== null) {
        // We've completed the root. Commit it.
        completeRoot(root, finishedWork, expirationTime);
      }
    }
  } else {
    // Flush async work.
    let finishedWork = root.finishedWork;
    if (finishedWork !== null) {
      // This root is already complete. We can commit it.
      completeRoot(root, finishedWork, expirationTime);
    } else {
      root.finishedWork = null;
      // If this root previously suspended, clear its existing timeout, since
      // we're about to try rendering again.
      const timeoutHandle = root.timeoutHandle;
      if (enableSuspense && timeoutHandle !== noTimeout) {
        root.timeoutHandle = noTimeout;
        // $FlowFixMe Complains noTimeout is not a TimeoutID, despite the check above
        cancelTimeout(timeoutHandle);
      }
      const isYieldy = true;
      renderRoot(root, isYieldy, isExpired);
      finishedWork = root.finishedWork;
      if (finishedWork !== null) {
        // We've completed the root. Check the deadline one more time
        // before committing.
        if (!shouldYield()) {
          // Still time left. Commit the root.
          completeRoot(root, finishedWork, expirationTime);
        } else {
          // There's no time left. Mark this root as complete. We'll come
          // back and commit it later.
          root.finishedWork = finishedWork;
        }
      }
    }
  }

  isRendering = false;
}

function completeRoot(
  root: FiberRoot,
  finishedWork: Fiber,
  expirationTime: ExpirationTime,
): void {
  // Check if there's a batch that matches this expiration time.
  const firstBatch = root.firstBatch;
  if (firstBatch !== null && firstBatch._expirationTime <= expirationTime) {
    if (completedBatches === null) {
      completedBatches = [firstBatch];
    } else {
      completedBatches.push(firstBatch);
    }
    if (firstBatch._defer) {
      // This root is blocked from committing by a batch. Unschedule it until
      // we receive another update.
      root.finishedWork = finishedWork;
      root.expirationTime = NoWork;
      return;
    }
  }

  // Commit the root.
  root.finishedWork = null;

  // Check if this is a nested update (a sync update scheduled during the
  // commit phase).
  if (root === lastCommittedRootDuringThisBatch) {
    // If the next root is the same as the previous root, this is a nested
    // update. To prevent an infinite loop, increment the nested update count.
    nestedUpdateCount++;
  } else {
    // Reset whenever we switch roots.
    lastCommittedRootDuringThisBatch = root;
    nestedUpdateCount = 0;
  }
  commitRoot(root, finishedWork);
}

// When working on async work, the reconciler asks the renderer if it should
// yield execution. For DOM, we implement this with requestIdleCallback.
function shouldYield() {
  if (deadlineDidExpire) {
    return true;
  }
  if (
    deadline === null ||
    deadline.timeRemaining() > timeHeuristicForUnitOfWork
  ) {
    // Disregard deadline.didTimeout. Only expired work should be flushed
    // during a timeout. This path is only hit for non-expired work.
    return false;
  }
  deadlineDidExpire = true;
  return true;
}

function onUncaughtError(error: mixed) {
  invariant(
    nextFlushedRoot !== null,
    'Should be working on a root. This error is likely caused by a bug in ' +
      'React. Please file an issue.',
  );
  // Unschedule this root so we don't work on it again until there's
  // another update.
  nextFlushedRoot.expirationTime = NoWork;
  if (!hasUnhandledError) {
    hasUnhandledError = true;
    unhandledError = error;
  }
}

// TODO: Batching should be implemented at the renderer level, not inside
// the reconciler.
function batchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    return fn(a);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

// TODO: Batching should be implemented at the renderer level, not inside
// the reconciler.
function unbatchedUpdates<A, R>(fn: (a: A) => R, a: A): R {
  if (isBatchingUpdates && !isUnbatchingUpdates) {
    isUnbatchingUpdates = true;
    try {
      return fn(a);
    } finally {
      isUnbatchingUpdates = false;
    }
  }
  return fn(a);
}

// TODO: Batching should be implemented at the renderer level, not within
// the reconciler.
function flushSync<A, R>(fn: (a: A) => R, a: A): R {
  invariant(
    !isRendering,
    'flushSync was called from inside a lifecycle method. It cannot be ' +
      'called when React is already rendering.',
  );
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    return syncUpdates(fn, a);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    performSyncWork();
  }
}

function interactiveUpdates<A, B, R>(fn: (A, B) => R, a: A, b: B): R {
  if (isBatchingInteractiveUpdates) {
    return fn(a, b);
  }
  // If there are any pending interactive updates, synchronously flush them.
  // This needs to happen before we read any handlers, because the effect of
  // the previous event may influence which handlers are called during
  // this event.
  if (
    !isBatchingUpdates &&
    !isRendering &&
    lowestPriorityPendingInteractiveExpirationTime !== NoWork
  ) {
    // Synchronously flush pending interactive updates.
    performWork(lowestPriorityPendingInteractiveExpirationTime, null);
    lowestPriorityPendingInteractiveExpirationTime = NoWork;
  }
  const previousIsBatchingInteractiveUpdates = isBatchingInteractiveUpdates;
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingInteractiveUpdates = true;
  isBatchingUpdates = true;
  try {
    return fn(a, b);
  } finally {
    isBatchingInteractiveUpdates = previousIsBatchingInteractiveUpdates;
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

function flushInteractiveUpdates() {
  if (
    !isRendering &&
    lowestPriorityPendingInteractiveExpirationTime !== NoWork
  ) {
    // Synchronously flush pending interactive updates.
    performWork(lowestPriorityPendingInteractiveExpirationTime, null);
    lowestPriorityPendingInteractiveExpirationTime = NoWork;
  }
}

function flushControlled(fn: () => mixed): void {
  const previousIsBatchingUpdates = isBatchingUpdates;
  isBatchingUpdates = true;
  try {
    syncUpdates(fn);
  } finally {
    isBatchingUpdates = previousIsBatchingUpdates;
    if (!isBatchingUpdates && !isRendering) {
      performSyncWork();
    }
  }
}

// Capture errors so they don't interrupt unmounting.
function safelyCallComponentWillUnmount(current, instance) {
  if (__DEV__) {
    invokeGuardedCallback(
      null,
      callComponentWillUnmountWithTimer,
      null,
      current,
      instance,
    );
    if (hasCaughtError()) {
      const unmountError = clearCaughtError();
      captureCommitPhaseError(current, unmountError);
    }
  } else {
    try {
      callComponentWillUnmountWithTimer(current, instance);
    } catch (unmountError) {
      captureCommitPhaseError(current, unmountError);
    }
  }
}

function safelyDetachRef(current: Fiber) {
  const ref = current.ref;
  if (ref !== null) {
    if (typeof ref === 'function') {
      if (__DEV__) {
        invokeGuardedCallback(null, ref, null, null);
        if (hasCaughtError()) {
          const refError = clearCaughtError();
          captureCommitPhaseError(current, refError);
        }
      } else {
        try {
          ref(null);
        } catch (refError) {
          captureCommitPhaseError(current, refError);
        }
      }
    } else {
      ref.current = null;
    }
  }
}

function commitUnmount(current: Fiber): void {
  onCommitUnmount(current);

  switch (current.tag) {
    case ClassComponent:
    case ClassComponentLazy: {
      safelyDetachRef(current);
      const instance = current.stateNode;
      if (typeof instance.componentWillUnmount === 'function') {
        safelyCallComponentWillUnmount(current, instance);
      }
      return;
    }
    case HostComponent: {
      safelyDetachRef(current);
      return;
    }
    case HostPortal: {
      // TODO: this is recursive.
      // We are also not using this parent because
      // the portal will get pushed immediately.
      if (supportsMutation) {
        unmountHostComponents(current);
      } else if (supportsPersistence) {
        emptyPortalContainer(current);
      }
      return;
    }
  }
}

function commitNestedUnmounts(root: Fiber): void {
  // While we're inside a removed host node we don't want to call
  // removeChild on the inner nodes because they're removed by the top
  // call anyway. We also want to call componentWillUnmount on all
  // composites before this host node is removed from the tree. Therefore
  // we do an inner loop while we're still inside the host node.
  let node: Fiber = root;
  while (true) {
    commitUnmount(node);
    // Visit children because they may contain more composite or host nodes.
    // Skip portals because commitUnmount() currently visits them recursively.
    if (
      node.child !== null &&
      // If we use mutation we drill down into portals using commitUnmount above.
      // If we don't use mutation we drill down into portals here instead.
      (!supportsMutation || node.tag !== HostPortal)
    ) {
      node.child.return = node;
      node = node.child;
      continue;
    }
    if (node === root) {
      return;
    }
    while (node.sibling === null) {
      if (node.return === null || node.return === root) {
        return;
      }
      node = node.return;
    }
    node.sibling.return = node.return;
    node = node.sibling;
  }
}

function unmountHostComponents(current): void {
  // We only have the top Fiber that was deleted but we need recurse down its
  // children to find all the terminal nodes.
  let node: Fiber = current;

  // Each iteration, currentParent is populated with node's host parent if not
  // currentParentIsValid.
  let currentParentIsValid = false;

  // Note: these two variables *must* always be updated together.
  let currentParent;
  let currentParentIsContainer;

  while (true) {
    if (!currentParentIsValid) {
      let parent = node.return;
      findParent: while (true) {
        invariant(
          parent !== null,
          'Expected to find a host parent. This error is likely caused by ' +
            'a bug in React. Please file an issue.',
        );
        switch (parent.tag) {
          case HostComponent:
            currentParent = parent.stateNode;
            currentParentIsContainer = false;
            break findParent;
          case HostRoot:
            currentParent = parent.stateNode.containerInfo;
            currentParentIsContainer = true;
            break findParent;
          case HostPortal:
            currentParent = parent.stateNode.containerInfo;
            currentParentIsContainer = true;
            break findParent;
        }
        parent = parent.return;
      }
    }

    if (node.tag === HostComponent || node.tag === HostText) {
      commitNestedUnmounts(node);
      // After all the children have unmounted, it is now safe to remove the
      // node from the tree.
      if (currentParentIsContainer) {
        removeChildFromContainer((currentParent: any), node.stateNode);
      } else {
        removeChild((currentParent: any), node.stateNode);
      }
      // Don't visit children because we already visited them.
    } else if (node.tag === HostPortal) {
      // When we go into a portal, it becomes the parent to remove from.
      // We will reassign it back when we pop the portal on the way up.
      currentParent = node.stateNode.containerInfo;
      currentParentIsContainer = true;
      // Visit children because portals might contain host components.
      if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
    } else {
      commitUnmount(node);
      // Visit children because we may find more host components below.
      if (node.child !== null) {
        node.child.return = node;
        node = node.child;
        continue;
      }
    }
    if (node === current) {
      return;
    }
    while (node.sibling === null) {
      if (node.return === null || node.return === current) {
        return;
      }
      node = node.return;
      if (node.tag === HostPortal) {
        // When we go out of the portal, we need to restore the parent.
        // Since we don't keep a stack of them, we will search for it.
        currentParentIsValid = false;
      }
    }
    node.sibling.return = node.return;
    node = node.sibling;
  }
}

function commitDeletion(current: Fiber): void {
  if (supportsMutation) {
    // Recursively delete all host nodes from the parent.
    // Detach refs and call componentWillUnmount() on the whole subtree.
    unmountHostComponents(current);
  } else {
    // Detach refs and call componentWillUnmount() on the whole subtree.
    commitNestedUnmounts(current);
  }
  detachFiber(current);
}

export {
  requestCurrentTime,
  computeExpirationForFiber,
  captureCommitPhaseError,
  onUncaughtError,
  renderDidSuspend,
  renderDidError,
  retrySuspendedRoot,
  markLegacyErrorBoundaryAsFailed,
  isAlreadyFailedLegacyErrorBoundary,
  scheduleWork,
  requestWork,
  flushRoot,
  batchedUpdates,
  unbatchedUpdates,
  flushSync,
  flushControlled,
  deferredUpdates,
  syncUpdates,
  interactiveUpdates,
  flushInteractiveUpdates,
  computeUniqueAsyncExpiration,
};
