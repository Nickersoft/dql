// @flow
import Processor from './Processor';
import QueryBuilder from '../util/QueryBuilder';
import Nodes from '../util/Nodes';
import Helpers from '../util/Helpers';
import JoinProcessor from './JoinProcessor';
import type { TableNode, Config, DocumentNode, FieldNode } from '../util/Types';

/**
 * MutationProcessor
 * ==============
 * Processes all mutation documents (the equivalent of an INSERT or UPDATE statement)
 */
class MutationProcessor extends Processor {
  _qb: QueryBuilder;

  /**
   * Adds fields from a table to a QueryBuilder object
   *
   * @param node          The table node
   * @param variables     Global variables
   * @param qb            The QueryBuilder
   * @private
   */
  _addTableFields(node: TableNode, variables: {}, qb: QueryBuilder) {
    const fields = node.nodes.filter(x => x.type === Nodes.FIELD);
    let count = 0;

    fields.forEach(field => {
      this._verifyField(field);

      try {
        switch (field.value.type) {
          case Nodes.VARIABLE:
            const variable = field.value.value;
            const val = variables[variable];

            if (typeof val !== 'undefined') {
              qb.set(field.name, val.value);
              count++;
            }

            break;
          case Nodes.RAW_TEXT:
            qb.set(field.name, this._qb.str(field.value.value));
            count++;
            break;
          default:
            qb.set(field.name, field.value.value);
            count++;
        }
      } catch (e) {
        console.error(
          `Value \`${field.value.value}\` for field \`${
            field.name
          }\` is invalid`
        );
      }
    });

    if (count === 0)
      throw new Error('At least one field must be set in a mutation');
  }

  /**
   * Verifies a field to make sure it is valid for a mutation
   *
   * @param field     The field node
   * @returns {boolean}
   * @private
   */
  _verifyField(field: FieldNode) {
    if (field.alias) throw new Error('Aliases not allowed in mutations');
    else if (field.value === null)
      throw new Error(`Value required for field '${field.name}'`);
    else return true;
  }

  /**
   * Processed an INSERT statement
   *
   * @param docroot          The document docroot
   * @param node          The table node
   * @param variables     Global variables
   * @param options       Config object
   * @returns {QueryBuilder}
   * @private
   */
  _processInsert(
    docroot: DocumentNode[],
    node: TableNode,
    variables: {},
    options: Config
  ) {
    const { name } = node;
    const { returning } = options;
    let qb = this._qb.insert().into(name);

    this._addTableFields(node, variables, qb);

    if (returning) qb.returning(returning);

    return qb;
  }

  /**
   * Processes an UPDATE statement
   *
   * @param docroot          The document docroot
   * @param node          The table node
   * @param variables     Global variables
   * @param options       Config object
   * @returns {QueryBuilder}
   * @private
   */
  _processUpdate(
    docroot: DocumentNode[],
    node: TableNode,
    variables: {},
    options: Config
  ) {
    const { name } = node;
    const { descending, orderBy, returning, limit } = options;

    // Initialize the query builder
    let qb = this._qb.update().table(name);

    // Iterate through each field and add it to the QueryBuilder
    this._addTableFields(node, variables, qb);

    // Apply a WHERE statement if applicable
    Helpers.applyWhereStatement(docroot, node, variables, qb);

    // Add order
    if (typeof orderBy !== 'undefined' && orderBy !== null)
      qb.order(orderBy, !descending);

    // Add limit
    if (typeof limit !== 'undefined' && limit !== null) qb.limit(limit);

    // Add returning
    if (typeof returning !== 'undefined' && returning !== null)
      qb.returning(returning);

    return qb;
  }

  _processDelete(
    docroot: DocumentNode[],
    node: TableNode,
    variables: {},
    options: Config
  ) {
    const { params, nodes, name } = node;
    const { orderBy, limit, returning, descending } = options;

    if (params.length === 0)
      throw new Error(
        'A selector statement is required for all delete statements'
      );
    else if (nodes.filter(x => x.type === Nodes.FIELD).length > 0)
      throw new Error('Fields are not allowed in delete statements');
    else {
      let qb = this._qb.delete().from(name);

      // Add JOIN statements
      qb = JoinProcessor(this._qb).process(docroot, node, variables, qb);

      // Add WHERE statement
      Helpers.applyWhereStatement(docroot, node, variables, qb);

      // Add order
      if (typeof orderBy !== 'undefined' && orderBy !== null)
        qb.order(orderBy, !descending);

      // Add limit
      if (typeof limit !== 'undefined' && limit !== null) qb.limit(limit);

      // Add returning
      if (typeof returning !== 'undefined' && returning !== null)
        qb.returning(returning);

      return qb;
    }

    return null;
  }

  /**
   * Processes a table node
   *
   * @param docroot          The document docroot
   * @param node          The table node
   * @param variables     Global variables
   * @param options       Config object
   * @returns {QueryBuilder}
   * @private
   */
  _processTable(
    docroot: DocumentNode[],
    node: TableNode,
    variables: {},
    options: Config
  ) {
    // Get the name and parameters associated with the table
    const { params, nodes } = node;
    const del = node.delete;

    let qb;

    if (del) qb = this._processDelete(docroot, node, variables, options);
    else {
      if (nodes.filter(x => x.type === Nodes.JOIN).length > 0)
        throw new Error('Join statements are not allowed in mutations');

      // If we have selectors, then we're updating a row
      if (params.length > 0)
        qb = this._processUpdate(docroot, node, variables, options);
      else qb = this._processInsert(docroot, node, variables, options);
    }

    return qb;
  }

  /**
   * Processes a query document
   *
   * @param docroot          docroot of the document
   * @param node          Query node
   * @param variables     Global variables
   * @returns {QueryBuilder}
   */
  process(
    docroot: DocumentNode[],
    node: DocumentNode,
    config: Config,
    qb: QueryBuilder = this._qb
  ): QueryBuilder {
    const { variables: req_var, nodes } = node;

    let { variables, ...options } = config;

    // Clone the variables
    variables = Object.assign({}, variables);

    if (node.type !== Nodes.MUTATION)
      throw new Error(
        'Only a mutation document node can be passed to a MutationProcessor'
      );

    req_var.forEach(v => {
      if (variables && variables.hasOwnProperty(v.name)) {
        variables[v.name] = {
          value: variables[v.name],
          required: v.required
        };
      } else {
        if (v.required) throw new Error(`Missing required variable ${v.name}`);
      }
    });

    const tables = nodes.filter(x => x.type === Nodes.TABLE);

    if (tables.length < 1)
      throw new Error('Mutations must contain at least one table');

    tables.forEach(table => {
      qb = this._processTable(docroot, table, variables || {}, options);
    });

    return qb;
  }
}

export default (flavor: string) => new MutationProcessor(QueryBuilder(flavor));
