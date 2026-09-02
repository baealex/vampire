export type StateMigrationContext = {
  stateDirectory: string;
};

export type StateMigrationSource = {
  name: string;
  layoutVersion: number;
  checksumInput: string;
  up: (context: StateMigrationContext) => Promise<void>;
  validate: (context: StateMigrationContext) => Promise<void>;
};
