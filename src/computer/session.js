'use strict';

/**
 * What one chat may do with the screen, and for how long. Each look at an app is a step; a session
 * has a step limit and a time limit, and the first look at each app needs the person's approval.
 * The emergency stop ends every session and keeps them ended until the person turns it back on.
 */

class SessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

class ComputerSessions {
  constructor({ maxSteps = 30, maxMs = 10 * 60 * 1000, now = () => Date.now(), onActive = () => {} } = {}) {
    this.maxSteps = maxSteps;
    this.maxMs = maxMs;
    this.now = now;
    this.onActive = onActive;
    this.sessions = new Map();
    this.halted = false;
    this.wasActive = false;
  }

  get(id) {
    const key = String(id || '');
    if (!key) throw new SessionError('no_session', 'Looking at the screen needs a conversation.');
    let session = this.sessions.get(key);
    if (!session) {
      session = { id: key, startedAt: this.now(), steps: 0, apps: new Set() };
      this.sessions.set(key, session);
      // Only a handful of conversations are tracked at once.
      if (this.sessions.size > 50) this.sessions.delete(this.sessions.keys().next().value);
    }
    return session;
  }

  isApproved(id, app) { return this.get(id).apps.has(app); }

  approve(id, app) {
    if (this.halted) throw new SessionError('halted', 'Computer use was stopped. Turn it back on in settings.');
    this.get(id).apps.add(app);
    this.notify();
  }

  /** Count one step. Refuses when stopped, out of steps or out of time (and then the session is over). */
  step(id) {
    if (this.halted) throw new SessionError('halted', 'Computer use was stopped. Turn it back on in settings.');
    const session = this.get(id);
    if (this.now() - session.startedAt > this.maxMs) { this.end(session.id); throw new SessionError('time_limit', 'This session used up its time. Ask the person to start again.'); }
    if (session.steps >= this.maxSteps) { this.end(session.id); throw new SessionError('step_limit', 'This session used up its steps. Ask the person to start again.'); }
    session.steps += 1;
    return { stepsLeft: this.maxSteps - session.steps };
  }

  end(id) {
    this.sessions.delete(String(id || ''));
    this.notify();
  }

  /** Screen locked, asleep, or the person moved to another app: every approval is forgotten, nothing else. */
  interrupt() {
    for (const session of this.sessions.values()) session.apps.clear();
    this.notify();
  }

  /** The emergency stop: everything ends and stays ended until `release`. */
  stopAll() {
    this.halted = true;
    this.sessions.clear();
    this.notify();
  }

  /** Called only after the person confirmed in a native dialog. */
  release() { this.halted = false; }

  /** Whether any session has an approved app (the stop shortcut is only registered then). */
  get active() { return [...this.sessions.values()].some((session) => session.apps.size > 0); }

  notify() {
    const active = this.active;
    if (active !== this.wasActive) { this.wasActive = active; try { this.onActive(active); } catch { /* a shortcut that cannot be set does not stop the stop */ } }
  }
}

module.exports = { ComputerSessions, SessionError };
