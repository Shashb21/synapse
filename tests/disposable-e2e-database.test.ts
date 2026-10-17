import { expect, it } from "vitest";
import { requireDisposableDatabase } from "../e2e/support/disposable-database";

it.each(["127.0.0.1:5432", "localhost:5433", "[::1]:5433"])("accepts the explicitly configured test database at %s", host => {
  const url = `postgres://synapse:synapse@${host}/synapse_e2e`;
  expect(requireDisposableDatabase(url)).toBe(url);
});
it.each([undefined, "", "not a URL", "https://localhost/synapse_e2e", "postgres://remote.example/synapse_e2e", "postgres://localhost/synapse", "postgres://localhost/synapse_test", "postgres://localhost/synapse_e2e_other", "postgres://localhost/synapse_e2e?host=remote.example", "postgres://localhost/synapse_e2e?dbname=synapse"])("rejects unsafe fixture configuration %s", value => {
  expect(() => requireDisposableDatabase(value)).toThrow(/disposable/);
});

it.each(["database=synapse", "application_name=fixture"])("rejects every query parameter, including %s", query => {
  expect(() => requireDisposableDatabase(`postgres://localhost/synapse_e2e?${query}`)).toThrow(/disposable/);
});
