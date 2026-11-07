import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { Subject, type Subscription } from "rxjs";
import type { OperationDto } from "@hosting-panel/contracts";

export interface OrganizationSseEvent {
  readonly event: "operation.updated";
  readonly organizationId: string;
  readonly operation: OperationDto;
  readonly emittedAt: string;
}

@Injectable()
export class EventsBusService implements OnModuleDestroy {
  readonly #subject = new Subject<OrganizationSseEvent>();
  readonly #activeClosers = new Set<() => void>();

  public publishOperationUpdated(operation: OperationDto): void {
    this.#subject.next({
      event: "operation.updated",
      organizationId: operation.organizationId,
      operation,
      emittedAt: new Date().toISOString(),
    });
  }

  public subscribeOrganization(
    organizationId: string,
    listener: (event: OrganizationSseEvent) => void,
  ): Subscription {
    return this.#subject.subscribe((payload) => {
      if (payload.organizationId === organizationId) {
        listener(payload);
      }
    });
  }

  public registerActiveStreamCloser(closer: () => void): () => void {
    this.#activeClosers.add(closer);
    return () => {
      this.#activeClosers.delete(closer);
    };
  }

  public onModuleDestroy(): void {
    for (const closer of [...this.#activeClosers]) {
      try {
        closer();
      } catch {
        // Ignore stream teardown errors during shutdown
      }
    }
    this.#activeClosers.clear();
    this.#subject.complete();
  }
}
