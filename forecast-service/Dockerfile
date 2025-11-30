FROM python:3.10-slim

WORKDIR /app

COPY . /app
COPY serviceAccountKey.json /app/serviceAccountKey.json

RUN pip install --no-cache-dir -r requirements.txt

ENV PYTHONUNBUFFERED=1
ENV PORT=8080

EXPOSE 8080

CMD ["python", "app.py"]
