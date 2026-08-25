const promise1 = new Promise((resolve) => {
  console.log("Promise 1 started");

  setTimeout(() => {
    console.log("Promise 1 finished");
    resolve("Result from Promise 1");
  }, 3500);
});

const promise2 = new Promise((resolve) => {
  console.log("Promise 2 started");

  setTimeout(() => {
    console.log("Promise 2 finished");
    resolve("Result from Promise 2");
  }, 3000);
});

async function main() {
  const results = await Promise.race([promise1, promise2]);
  console.log("Results:", results);
}

main();