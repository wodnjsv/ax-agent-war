FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY app ./app
COPY problem1 ./problem1
COPY problem2 ./problem2
COPY problem3 ./problem3
COPY problem4 ./problem4
COPY 01_참가자_배포용/04_원본데이터 ./01_참가자_배포용/04_원본데이터
RUN mkdir -p var && chown node:node var
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["npm", "start"]
