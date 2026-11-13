/**
 * Round-robin across the projects one runner process serves (t1112, FR13).
 *
 * A multi-project runner keeps one `Controller` per project and does not modify
 * it: a controller polls and leases inside one partition, which is exactly the
 * scoping the control plane enforces (`409 cross_project_reference`). What is
 * left to decide is only which controller is asked first on each pass, and this
 * file is that decision.
 *
 * Three rules, each with a plausible opposite:
 *
 * - **The cursor is a project id, never an index.** Under `--all-projects` the
 *   served set grows while the runner runs. An index kept across a set that
 *   grew in the middle would skip or repeat a project; an id keeps its place,
 *   and a newcomer simply takes its turn in id order from the next pass.
 * - **Only a dispatch, or a rejection, spends a turn.** A project with nothing
 *   released answers `null` and the pass goes on to the next one, so an empty
 *   project costs one poll and never a whole pass. A project whose tick rejects
 *   (a failed session, a poll error) moves the cursor past itself BEFORE the
 *   error travels up, so a project that fails on every pass cannot hold the
 *   rotation and starve the others.
 * - **At most one dispatch per pass.** The process still runs one session at a
 *   time (a tick awaits its whole dispatch), and a pass that went on after a
 *   dispatch would let one project serve twice in a row while another waited.
 *
 * English only.
 */

import type { DispatchResult } from './controller.ts';

/** One project in the rotation: its id, and the controller that serves it. */
export interface RotationMember {
  projectId: number;
  controller: { tick: () => Promise<DispatchResult | null> };
}

/** What one pass dispatched, and in which project. */
export interface RotationOutcome {
  projectId: number;
  result: DispatchResult;
}

/** The round-robin itself: a cursor kept by project id, across passes. */
export class ProjectRotation {
  /** The project that dispatched (or rejected) last, or `null` before any did. */
  #cursor: number | null = null;

  /**
   * One pass: asks each project in turn, starting after the one served last,
   * until one dispatches or all have answered `null`.
   *
   * @param members The projects served now, in any order; sorted here by id.
   * @param stopped Asked before each project after the first; `true` ends the
   *   pass without asking the rest, so a stop lands between two projects.
   * @returns What was dispatched, or `null` when nothing was.
   * @throws Whatever a project's tick rejected with, after the cursor has moved
   *   past that project.
   */
  async pass(
    members: readonly RotationMember[],
    stopped: () => boolean = () => false,
  ): Promise<RotationOutcome | null> {
    const ordered = [...members].sort((left, right) => left.projectId - right.projectId);
    if (ordered.length === 0) return null;

    const cursor = this.#cursor;
    const after = cursor === null ? -1 : ordered.findIndex((member) => member.projectId > cursor);
    const start = after === -1 ? 0 : after;

    for (let offset = 0; offset < ordered.length; offset += 1) {
      if (offset > 0 && stopped()) return null;

      const member = ordered[(start + offset) % ordered.length];
      let result: DispatchResult | null;
      try {
        result = await member.controller.tick();
      } catch (error) {
        this.#cursor = member.projectId;
        throw error;
      }

      if (result !== null) {
        this.#cursor = member.projectId;
        return { projectId: member.projectId, result };
      }
    }

    return null;
  }
}
