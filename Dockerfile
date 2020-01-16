FROM node

RUN yarn global add typescript
# RUN yarn global add vsce # Does not work for some reason.  js.  whatever.
RUN npm install -g vsce
