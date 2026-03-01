import { PureAbility, AbilityBuilder } from "@casl/ability";

export type Action = "read" | "create" | "update" | "delete";

export type Subject =
  | "verses"
  | "sources"
  | "contributions"
  | "word-translations"
  | "footnotes"
  | "issues"
  | "queue"
  | "users";

export type AppAbility = PureAbility<[Action, Subject]>;

export type Role = "guest" | "contributor" | "admin";

export function defineAbilitiesFor(role: Role): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(PureAbility);

  // Guest permissions
  can("read", "verses");
  can("read", "sources");

  if (role === "contributor" || role === "admin") {
    can("read", "contributions");
    can("create", "contributions");
    can("read", "word-translations");
    can("create", "word-translations");
    can(["read", "create", "update", "delete"], "footnotes");
    can("read", "issues");
  }

  if (role === "admin") {
    can(["read", "create", "update", "delete"], "sources");
    can("update", "contributions");
    can("update", "word-translations");
    can(["read", "update"], "queue");
    can(["read", "create", "update", "delete"], "users");
  }

  return build();
}
