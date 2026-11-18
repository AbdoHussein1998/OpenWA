



import {
  validate,
  type ValidationError,
} from 'class-validator';

import { CreateAgentDto } from './create-agent.dto';

function createDto(
  overrides: Partial<CreateAgentDto> = {},
): CreateAgentDto {
  return Object.assign(
    new CreateAgentDto(),
    {
      name:
        'Quota Agent',

      ...overrides,
    },
  );
}

function errorFor(
  errors: ValidationError[],
  property: string,
): ValidationError | undefined {
  return errors.find(
    error => error.property === property,
  );
}

describe(
  'CreateAgentDto',
  () => {
    describe(
      'templateSendLimit24h',
      () => {
        it.each([
          {
            label:
              'omitted',
            value:
              undefined,
          },

          {
            label:
              'null (unlimited)',
            value:
              null,
          },

          {
            label:
              'zero (disabled)',
            value:
              0,
          },

          {
            label:
              'one',
            value:
              1,
          },

          {
            label:
              'a positive integer',
            value:
              25,
          },
        ])(
          'accepts $label',
          async ({ value }) => {
            const dto =
              value === undefined
                ? createDto()
                : createDto({
                    templateSendLimit24h:
                      value,
                  });

            const errors =
              await validate(dto);

            expect(
              errorFor(
                errors,
                'templateSendLimit24h',
              ),
            ).toBeUndefined();
          },
        );

        it.each([
          {
            label:
              'a negative integer',
            value:
              -1,
            constraint:
              'min',
          },

          {
            label:
              'a decimal number',
            value:
              1.5,
            constraint:
              'isInt',
          },

          {
            label:
              'a numeric string',
            value:
              '10',
            constraint:
              'isInt',
          },
        ])(
          'rejects $label',
          async ({
            value,
            constraint,
          }) => {
            const dto =
              createDto();

            (
              dto as unknown as {
                templateSendLimit24h:
                  unknown;
              }
            ).templateSendLimit24h =
              value;

            const errors =
              await validate(dto);

            const quotaError =
              errorFor(
                errors,
                'templateSendLimit24h',
              );

            expect(
              quotaError,
            ).toBeDefined();

            expect(
              quotaError?.constraints,
            ).toHaveProperty(
              constraint,
            );
          },
        );

        it(
          'rejects non-finite numeric values',
          async () => {
            for (const value of [
              Number.NaN,
              Number.POSITIVE_INFINITY,
              Number.NEGATIVE_INFINITY,
            ]) {
              const dto =
                createDto({
                  templateSendLimit24h:
                    value,
                });

              const errors =
                await validate(dto);

              expect(
                errorFor(
                  errors,
                  'templateSendLimit24h',
                ),
              ).toBeDefined();
            }
          },
        );
      },
    );

    it(
      'still validates the existing required Agent name contract',
      async () => {
        const dto =
          createDto({
            name: '',
          });

        const errors =
          await validate(dto);

        expect(
          errorFor(
            errors,
            'name',
          ),
        ).toBeDefined();
      },
    );
  },
);




