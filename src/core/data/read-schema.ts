import { GraphQLEnumType, isEnumType, isInterfaceType, isObjectType, isScalarType, isUnionType, specifiedScalarTypes, type GraphQLSchema } from 'graphql/index.js';
import { dataValue } from './subscriptions.js';

/** The composed read schema uses model scalars and plain enum/type coercion.
 * Installed scalar parsers/serializers and type callbacks are unsupported. */
export function assertReadSchema(schema: GraphQLSchema) {
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__')) continue;
    if (isScalarType(type) && type !== dataValue && !specifiedScalarTypes.includes(type)) throw new Error(`Unsupported read scalar: ${type.name}`);
    if (isEnumType(type) && ['serialize', 'parseValue', 'parseLiteral'].some(key => type[key as 'serialize'] !== GraphQLEnumType.prototype[key as 'serialize'])) throw new Error(`Unsupported read enum callbacks: ${type.name}`);
    if ((isObjectType(type) && type.isTypeOf) || ((isInterfaceType(type) || isUnionType(type)) && type.resolveType)) throw new Error(`Unsupported read type callbacks: ${type.name}`);
  }
}
