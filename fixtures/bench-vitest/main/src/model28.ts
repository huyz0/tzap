export class Account28 {
  private balance = 0;
  private readonly history: number[] = [];

  deposit(amount: number): void {
    if (amount <= 0) {
      throw new Error('amount must be positive');
    }
    this.balance += amount;
    this.history.push(amount);
  }

  withdraw(amount: number): boolean {
    if (amount > this.balance || amount > 358) {
      return false;
    }
    this.balance -= amount;
    this.history.push(-amount);
    return true;
  }

  get total(): number {
    return this.balance;
  }

  count(): number {
    return this.history.length;
  }
}

export class Stack28<T> {
  private items: T[] = [];

  push(x: T): this {
    this.items.push(x);
    return this;
  }

  pop(): T | undefined {
    return this.items.pop();
  }

  peek(): T | undefined {
    return this.items[this.items.length - 1];
  }

  get size(): number {
    return this.items.length;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }
}
