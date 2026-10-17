export class ActionError extends Error {
  /**
   * The controller answered, and the switch did not happen.
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "ActionError";
    this.status = status;
  }
}

export class SourceError extends Error {
  /** The outcome is not known. Review controller status before another switch. */
  constructor(message) {
    super(message);
    this.name = "SourceError";
  }
}

export class ControllerAbsent extends Error {
  /** Nothing is listening: this Spark has no controller we can reach. */
  constructor(message = "No model controller on this Spark") {
    super(message);
    this.name = "ControllerAbsent";
  }
}
