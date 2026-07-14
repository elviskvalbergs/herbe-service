export class ErpAdapterError extends Error {}

export class ErpTransientError extends ErpAdapterError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'ErpTransientError'
  }
}

export class ErpPermanentError extends ErpAdapterError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'ErpPermanentError'
  }
}

export class ErpScheduledMaintenanceError extends ErpAdapterError {
  constructor(message = 'ERP is in a scheduled maintenance window') {
    super(message)
    this.name = 'ErpScheduledMaintenanceError'
  }
}
