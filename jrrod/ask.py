#!/usr/bin/env python3

from openai import OpenAI

client = OpenAI();
def ask(input, context = None):
    request = [{"role":"user", "content":str(input)}];

    if context:
        request.append({   
            "role": "system",
            "content": [{ "type":"input_text", "text":str(context), }]
        });

    return client.responses.create(model= "gpt-4.1-nano", input=request);

def main():
    question = input("Ask a question: ");

    response = ask(
        question,
        context = "Do not yap! You are answering questions for our Q&A app. We want the simplest, shortest answers that respond to all points in the question.",
    );

    # Extract and print the text output
    print("\nAnswer:");
    print(response.output_text);

if __name__ == "__main__": main();
