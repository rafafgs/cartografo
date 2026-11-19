### t1313 (developing, unverified)

- Adding an optional field to an event's data is NOT invisible. requireValidData normalizes every declared optional field to null, so packages/core/test/sessions.test.ts's six exact session.finished deepEquals had to gain 'error: null'. specs/events/schemas/session.finished.schema.json closes additionalProperties, so the schema and specs/events/tests/schemas.test.mjs's TABLE had to gain the key too. Without that, every closure would have failed it. All three files are outside the ticket's declared surface. This is the same pattern t1282 hit with capability.
