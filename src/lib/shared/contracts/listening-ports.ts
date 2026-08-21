export type ListeningPortTermination = 'available' | 'protected' | 'permission-denied' | 'unavailable';

export interface ListeningPort {
  protocol: 'tcp';
  port: number;
  addresses: string[];
  pid: number | null;
  processName: string | null;
  cwd: string | null;
  termination: ListeningPortTermination;
}

export interface ListeningPortsResponse {
  ports: ListeningPort[];
}

export interface TerminateListeningProcessRequest {
  port: number;
  processName: string | null;
  cwd: string | null;
}
