
//////////////////////////////////////ex1
/*class User {           // bluePrint
  name; // property
  age;
  email;

  constructor(name, age, email) {
    this.name = name;
    this.age = age;
    this.email = email;
  }
  introduce() {
    return "Hi, I'm Hakim and I'm 20 years old";
  }
}

const user1 = new User("Hakim", 20, "hakim@example.com");
const user2 = new User("Ahmed", 25, "ahmed@example.com");

console.log(user1.introduce());
console.log(user2.introduce());
*/
////////////////////////////////////////ex2
class BankAccount{

  private balance : number = 0;
  public owner;
  

  constructor(owner : string,initiateBalance:number){
    this.owner = owner
    this.balance = initiateBalance
  }

  deposit(amount:number){
    if(amount < 0 )return
    this.balance += amount
  }
    withdraw(amount:number){
    if(amount < 0 )return
    this.balance -= amount
  }


getBalance(){
  return this.balance
}

}


const account = new BankAccount("Hakim", 1000);

account.deposit(500);
account.withdraw(200);

console.log(account.getBalance());


