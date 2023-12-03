import { tokenize } from './tokenizer';
import { printErrorLineAndContent } from './error';
import { isArgument } from './arguments';
import {
  ActionBlock,
  ActionStatement,
  AssertionBlock,
  AssertionStatement,
  Block,
  GivenWhenThenStatements,
  Statement,
  StatementSection,
  SystemLevelStatement,
} from './interfaces/statements.interface';
import { Token } from './interfaces/token.interface';

export class Parser {
  sentence = '';
  tokens: Token[] = [];
  index = 0;

  get currentToken(): Token {
    return this.tokens[this.index];
  }

  get previousToken(): Token {
    return this.tokens[this.index - 1];
  }

  get currentValue(): string {
    return this.currentToken?.value;
  }

  get currentKind(): Token['kind'] {
    return this.currentToken?.kind;
  }

  /**
   * @param {string} sentence - sentence to parse
   * @returns {GivenWhenThenStatements} parsed sentence
   */
  public parse(sentence: string): StatementSection[] {
    this.sentence = sentence;
    this.tokens = tokenize(sentence);
    this.index = 0;

    if (this.tokens.length === 0) {
      throw new Error('Empty sentence');
    }

    const statementSections: StatementSection[] = [];

    while (!this.isAtEnd()) {
      if (this.matches('given', 'when')) {
        statementSections.push(this.parseGivenWhenThen());
      } else {
        statementSections.push(this.parseBlock());
      }

      if (this.matchesKind('done')) {
        this.index++;
      } else if (!this.isAtEnd()) {
        this.error('Expected "done"');
      }
    }

    return statementSections;
  }

  private parseGivenWhenThen(): GivenWhenThenStatements {
    const startIndex = this.currentToken.index;
    const given = this.parseGiven();
    const when = this.parseWhen();
    const then = this.parseThen();

    return {
      kind: 'given-when-then',
      given,
      when,
      then,
      source: this.getSource(startIndex),
    };
  }

  private parseBlock(): Block {
    const startIndex = this.currentToken.index;
    const fullHeader = this.consumeBlockHeader();

    if (this.isActionBlockHeader(fullHeader)) {
      return {
        kind: 'action-block',
        header: fullHeader.slice(3),
        body: this.parseBullets(),
        source: this.getSource(startIndex),
      } satisfies ActionBlock;
    } else if (this.isAssertionBlockHeader(fullHeader)) {
      const indexOfTo = fullHeader.findIndex(
        (t) => t.value.toLowerCase() === 'to',
      );
      return {
        kind: 'assertion-block',
        header: fullHeader.slice(indexOfTo + 1),
        body: this.parseBullets(),
        source: this.getSource(startIndex),
      } satisfies AssertionBlock;
    } else {
      this.error(
        'Unexpected block header. Block header must start with "In order to" or follow "For ... to ..." structure.',
      );
    }

    throw new Error('Unreachable code.');
  }

  private getSource(startIndex: number): string {
    return this.sentence.slice(
      startIndex,
      this.matchesKind('done')
        ? this.currentToken.index + this.currentToken.value.length
        : this.previousToken.index + this.previousToken.value.length,
    );
  }

  parseGiven(): Statement[] {
    if (this.matches('given')) {
      this.index++;
      return this.parseStatements();
    }

    return [];
  }

  parseWhen(): Statement[] {
    this.consume('when', 'Expected "when"');
    return this.parseStatements();
  }

  parseThen(): Statement[] {
    this.consume('then', 'Expected "then"');
    return this.parseStatements();
  }

  private isAssertionBlockHeader(fullHeader: Token[]): boolean {
    if (fullHeader[0].value.toLowerCase() !== 'for') {
      return false;
    }

    const indexOfTo = fullHeader.findIndex(
      (t) => t.value.toLowerCase() === 'to',
    );

    if (indexOfTo === -1) {
      return false;
    }

    return indexOfTo < fullHeader.length - 1 && indexOfTo > 1;
  }

  private isActionBlockHeader(fullHeader: Token[]): boolean {
    return fullHeader
      .map((token) => token.value)
      .join(' ')
      .toLowerCase()
      .startsWith('in order to');
  }

  parseStatements(): Statement[] {
    const statements: Statement[] = [];

    while (
      !this.isAtEnd() &&
      !this.matches('given', 'when', 'then') &&
      !this.matchesKind('bullet', 'done')
    ) {
      statements.push(this.parseStatement());

      if (this.matches('and') || this.matchesKind('bullet')) {
        this.index++;
      } else {
        break;
      }
    }

    if (statements.length === 0) {
      this.error('Missing statement');
    }

    return statements;
  }

  private parseStatement(): Statement {
    if (this.matches('I')) {
      this.index++;
      return this.parseActionStatement();
    } else {
      return this.parseAssertionOrSystemStateChangeStatement();
    }
  }

  private parseAssertionOrSystemStateChangeStatement():
    | SystemLevelStatement
    | AssertionStatement {
    const { tokensBeforeShould, tokensAfterShould, foundShould } =
      this.extractAssertionOrSystemStateChangeTokens();

    if (foundShould) {
      return this.buildAssertionStatement(
        tokensAfterShould,
        tokensBeforeShould,
        tokensBeforeShould[0]?.index ?? tokensAfterShould[0].index,
      );
    } else {
      return this.buildSystemStateChangeStatement(tokensBeforeShould);
    }
  }

  private extractAssertionOrSystemStateChangeTokens(): {
    tokensBeforeShould: Token[];
    tokensAfterShould: Token[];
    foundShould: boolean;
  } {
    const tokensBeforeShould = [];
    const tokensAfterShould = [];
    let foundShould = false;

    while (
      !this.isAtEnd() &&
      !this.matches('given', 'when', 'then', 'and') &&
      !this.matchesKind('bullet', 'done')
    ) {
      if (this.matches('should')) {
        foundShould = true;
      } else {
        if (foundShould) {
          tokensAfterShould.push(this.currentToken);
        } else {
          tokensBeforeShould.push(this.currentToken);
        }
      }

      this.index++;
    }
    return { tokensBeforeShould, tokensAfterShould, foundShould };
  }

  private buildSystemStateChangeStatement(
    tokensBeforeShould: Token[],
  ): SystemLevelStatement {
    const tokens = tokensBeforeShould.filter(
      (token) => !isArgument(token.value),
    );
    const args = tokensBeforeShould.filter((token) => isArgument(token.value));
    return {
      kind: 'system-level',
      tokens,
      args,
      index: tokens[0].index,
    } satisfies SystemLevelStatement;
  }

  private buildAssertionStatement(
    tokensAfterShould: Token[],
    tokensBeforeShould: Token[],
    index: number,
  ): AssertionStatement {
    const assertion = tokensAfterShould.filter(
      (token) => !isArgument(token.value),
    );
    const args = tokensAfterShould.filter((token) => isArgument(token.value));
    return {
      kind: 'assertion',
      target: tokensBeforeShould,
      assertion,
      args,
      firstToken: tokensAfterShould[0],
      index,
    } satisfies AssertionStatement;
  }

  private parseActionStatement(): ActionStatement {
    const tokens = this.consumeAction();

    return {
      kind: 'action',
      tokens,
      index: tokens[0].index,
    } satisfies ActionStatement;
  }

  consumeAction(): Token[] {
    const action = [];

    while (
      !this.isAtEnd() &&
      !this.matches('then', 'when', 'and') &&
      !this.matchesKind('bullet', 'done')
    ) {
      this.reject(['I'], 'Unexpected "I" in action name');
      action.push(this.currentToken);
      this.index++;
    }

    if (action.length === 0) {
      this.error('Missing action');
    }

    return action;
  }

  matches(...candidates: string[]): boolean {
    return candidates
      .map((candidate) => candidate.toLowerCase())
      .includes(this.currentValue?.toLowerCase());
  }

  matchesKind(...kinds: Token['kind'][]): boolean {
    return kinds.includes(this.currentKind);
  }

  consume(expectedTokenValue: string, errorMessage: string): void {
    if (this.matches(expectedTokenValue)) {
      this.index++;
    } else {
      this.error(errorMessage);
    }
  }

  reject(rejectedStrings: string[], errorMessage: string): void {
    if (this.matches(...rejectedStrings)) {
      this.error(errorMessage);
    }
  }

  rejectKind(rejectedKinds: Token['kind'][], errorMessage: string): void {
    if (this.matchesKind(...rejectedKinds)) {
      this.error(errorMessage);
    }
  }

  error(errorMessage: string): void {
    throw new Error(errorMessage + '\n' + this.printErrorLocation());
  }

  printErrorLocation(): string {
    if (this.isAtEnd()) {
      const line = this.sentence.split('\n').length;
      const column = this.sentence.split('\n')[line - 1].length + 1;
      return printErrorLineAndContent(this.sentence, line, column);
    } else {
      const line = this.currentToken.line;
      const column = this.currentToken.column;
      return printErrorLineAndContent(this.sentence, line, column);
    }
  }

  isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }

  private consumeBlockHeader(): Token[] {
    const blockName = [];

    while (!this.isAtEnd() && !this.matchesKind('colon')) {
      this.rejectKind(['bullet'], 'Unexpected bullet in block header');
      blockName.push(this.currentToken);
      this.index++;
    }

    if (blockName.length === 0) {
      this.error('Missing block name');
    }

    return blockName;
  }

  parseBullets(): Statement[] {
    const statements: Statement[] = [];

    while (!this.isAtEnd() && !this.matches('done')) {
      if (this.matchesKind('bullet')) {
        this.index++;
        statements.push(this.parseStatement());
      } else {
        this.index++;
      }
    }

    return statements;
  }
}
