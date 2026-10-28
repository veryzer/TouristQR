import test from "node:test";
import assert from "node:assert/strict";
import { buildGoogleTourDirectionsUrl, partitionTourStops, tourMapAddress } from "../js/tour-map.js";

test("tourMapAddress uses mapsQuery only", () => {
  assert.equal(tourMapAddress({ name: "X", mapsQuery: "  Geelong " }), "Geelong");
  assert.equal(tourMapAddress({ name: "X" }), "");
});

test("partitionTourStops splits mappable and needs address", () => {
  const sites = [
    { id: "a", mapsQuery: "A st" },
    { id: "b", name: "No map" },
  ];
  const { mappable, needsAddress } = partitionTourStops(sites);
  assert.equal(mappable.length, 1);
  assert.equal(needsAddress.length, 1);
  assert.equal(needsAddress[0].id, "b");
});

test("buildGoogleTourDirectionsUrl single stop", () => {
  const url = buildGoogleTourDirectionsUrl("Start here", [{ id: "a", mapsQuery: "End here" }]);
  assert.match(url, /origin=Start/);
  assert.match(url, /destination=End/);
});

test("buildGoogleTourDirectionsUrl optimises middle stops", () => {
  const stops = [
    { id: "a", mapsQuery: "A" },
    { id: "b", mapsQuery: "B" },
    { id: "c", mapsQuery: "C" },
  ];
  const url = buildGoogleTourDirectionsUrl("Start", stops);
  assert.match(url, /waypoints=optimize/);
  assert.match(url, /destination=C/);
});
