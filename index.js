// go to chrome://inspect/#devices
// node --inspect index.js


const promise1 = new Promise((resolve) => {
  console.log("Promise 1 started");

  setTimeout(() => {
    console.log("Promise 1 finished");
    resolve("Result from Promise 1");
  }, 52000);
});

const promise2 = new Promise((resolve) => {
  console.log("Promise 2 started");

  setTimeout(() => {
    console.log("Promise 2 finished");
    resolve("Result from Promise 2");
  }, 50000);
});

async function main() {
  const results = await Promise.race([
    promise1,
    promise2
  ]);
  console.log("Results:", results);
}

main();

let time = 3;
setInterval(() => {
  console.log(`Passaram ${time}s`);
  time+=3;
}, 3000);