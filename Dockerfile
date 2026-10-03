# node 22+ is required by @shopify/shopify-api v15 and @shopify/shopify-app-express v8
# (both declare engines.node ">=22.0.0"). Was node:18-alpine.
FROM node:22-alpine

ARG SHOPIFY_API_KEY
ENV SHOPIFY_API_KEY=$SHOPIFY_API_KEY
EXPOSE 8081
WORKDIR /app
COPY web .
RUN npm install
RUN cd frontend && npm install && npm run build
CMD ["npm", "run", "serve"]
